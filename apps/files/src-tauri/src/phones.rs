//! Paired phones, as devices.
//!
//! KDE Connect mounts a phone's storage with sshfs under `$XDG_RUNTIME_DIR`,
//! where GIO's volume monitor does not look — so the phone that ewe Mobile and
//! the Phone plugin know never showed in this window. This module asks KDE
//! Connect's daemon who is paired, whether it is in reach and whether its
//! storage is mounted, and hands them to the device rows beside GIO's; Connect
//! and Disconnect go through the daemon too (`mountAndWait`, `unmount`).
//!
//! Three rules:
//! - **Never start the daemon.** A method call to the service's NAME starts it
//!   (D-Bus activation), and a daemon that was not running would become a new
//!   device on the network because a file manager opened. Every call goes to
//!   the daemon's own bus address (`:1.42`), which the bus starts nothing for;
//!   no owner of the name means no phones.
//! - **A signal only means "look again".** What is shown is what the daemon
//!   answers when asked, never what a signal said.
//! - **Names and folders come from the phone.** A folder is only taken when it
//!   is inside the phone's own mount point; a name is cut to one short line.

use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Map, Value as Json};
use zbus::Connection;
use zbus::zvariant::{OwnedValue, Structure, Value};

use crate::devices::Device;
use crate::ops::Emit;

const SERVICE: &str = "org.kde.kdeconnect";
const ROOT: &str = "/modules/kdeconnect";
const DAEMON: &str = "org.kde.kdeconnect.daemon";
const DEVICE: &str = "org.kde.kdeconnect.device";
const SFTP: &str = "org.kde.kdeconnect.device.sftp";
const PROPS: &str = "org.freedesktop.DBus.Properties";
const STORAGE: &str = "kdeconnect_sftp";

/// The daemon answers from memory in milliseconds; longer is a hung daemon.
const ANSWER: Duration = Duration::from_secs(5);
/// … except mounting, which waits for the phone (unlocked, on the network).
const PATIENT: Duration = Duration::from_secs(45);
/// A phone coming into reach loads twenty plugins: one look for all of it.
const SETTLE: Duration = Duration::from_millis(300);

/// The device ids this module owns: `kdc:<device>` and, for a phone with more
/// than one folder (an SD card), `kdc:<device>/<n>` for the others.
pub const PREFIX: &str = "kdc:";

/// One paired device that offers its storage.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Phone {
    pub id: String,
    pub name: String,
    /// in reach, with its storage feature loaded: Connect can work
    pub ready: bool,
    pub mounted: bool,
    /// (folder, its name on the phone), while mounted
    pub dirs: Vec<(String, String)>,
}

static ROWS: Mutex<Vec<Device>> = Mutex::new(Vec::new());

/// The phones as device rows, as last read. Never blocks: the watcher keeps it.
pub fn list() -> Vec<Device> {
    ROWS.lock().map(|r| r.clone()).unwrap_or_default()
}

/// One path element as kdeconnectd writes its device ids: letters, digits,
/// underscore. Anything else never reaches an object path.
fn element_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// `kdc:<device>` or `kdc:<device>/<n>` → `<device>`.
pub fn device_of(id: &str) -> Option<&str> {
    let rest = id.strip_prefix(PREFIX)?;
    let dev = rest.split('/').next().unwrap_or("");
    element_ok(dev).then_some(dev)
}

/// A name the phone gave, as one short line of text.
fn tidy(name: &str, fallback: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        fallback.to_string()
    } else {
        clean.chars().take(64).collect()
    }
}

/// Is `dir` a folder of the mount at `mount` — inside it, with no way back out?
fn dir_ok(dir: &str, mount: &str) -> bool {
    let (dir, mount) = (Path::new(dir), Path::new(mount));
    mount.is_absolute()
        && dir.starts_with(mount)
        && dir.components().all(|c| !matches!(c, Component::ParentDir))
}

/// The device rows for these phones. A phone that is away stays, as a place
/// that is not there now; a mounted one is a row per folder it shares.
pub fn rows(phones: &[Phone]) -> Vec<Device> {
    let mut out = Vec::new();
    for p in phones {
        let row = |id: String, label: String, path: Option<String>| Device {
            id,
            label,
            icon: "smartphone",
            kind: "phone",
            path,
            uri: None,
            mounted: p.mounted,
            can_mount: p.ready && !p.mounted,
            can_unmount: p.mounted,
            can_eject: false,
            removable: true,
            size: None,
            away: !p.ready && !p.mounted,
        };
        let base = format!("{PREFIX}{}", p.id);
        if !p.mounted || p.dirs.is_empty() {
            out.push(row(base, p.name.clone(), None));
            continue;
        }
        for (n, (dir, name)) in p.dirs.iter().enumerate() {
            let (id, label) = if n == 0 {
                (base.clone(), p.name.clone())
            } else {
                (format!("{base}/{n}"), format!("{} · {name}", p.name))
            };
            out.push(row(id, label, Some(dir.clone())));
        }
    }
    out
}

// ── the bus ─────────────────────────────────────────────────────────────────

/// A D-Bus value as plain JSON: variants unwrapped, structs as arrays.
fn to_json(v: &Value<'_>) -> Json {
    match v {
        Value::Bool(x) => Json::from(*x),
        Value::I32(x) => Json::from(*x),
        Value::U32(x) => Json::from(*x),
        Value::I64(x) => Json::from(*x),
        Value::U64(x) => Json::from(*x),
        Value::Str(s) => Json::from(s.as_str()),
        Value::Value(inner) => to_json(inner),
        Value::Array(a) => Json::Array(a.iter().map(to_json).collect()),
        Value::Structure(s) => Json::Array(s.fields().iter().map(to_json).collect()),
        Value::Dict(d) => {
            let mut m = Map::new();
            for (k, val) in d.iter() {
                if let Value::Str(s) = k {
                    m.insert(s.as_str().to_string(), to_json(val));
                }
            }
            Json::Object(m)
        }
        _ => Json::Null,
    }
}

/// The daemon's own address on the bus, None while it is not running. Asking
/// the bus who owns a name never starts anything.
async fn owner(conn: &Connection) -> Option<String> {
    let dbus = zbus::fdo::DBusProxy::new(conn).await.ok()?;
    let name = SERVICE.try_into().ok()?;
    dbus.get_name_owner(name)
        .await
        .ok()
        .map(|o| o.as_str().to_string())
}

/// Call a method on the daemon at `to` (its unique address); the first reply
/// argument as JSON, Null for none.
async fn call<B>(
    conn: &Connection,
    to: &str,
    limit: Duration,
    path: &str,
    iface: &str,
    method: &str,
    body: &B,
) -> Result<Json, String>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    let reply = tokio::time::timeout(
        limit,
        conn.call_method(Some(to), path, Some(iface), method, body),
    )
    .await
    .map_err(|_| "KDE Connect didn’t answer.".to_string())?
    .map_err(|e| match e {
        zbus::Error::MethodError(name, detail, _) => detail
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| name.to_string()),
        other => other.to_string(),
    })?;
    let body = reply.body();
    if body.signature().to_string().is_empty() {
        return Ok(Json::Null);
    }
    let s: Structure<'_> = body.deserialize().map_err(|e| e.to_string())?;
    Ok(s.fields().first().map(to_json).unwrap_or(Json::Null))
}

async fn props(conn: &Connection, to: &str, path: &str) -> Option<Map<String, Json>> {
    let reply = tokio::time::timeout(
        ANSWER,
        conn.call_method(Some(to), path, Some(PROPS), "GetAll", &(DEVICE,)),
    )
    .await
    .ok()?
    .ok()?;
    let all: HashMap<String, OwnedValue> = reply.body().deserialize().ok()?;
    Some(all.iter().map(|(k, v)| (k.clone(), to_json(v))).collect())
}

fn has(list: &Json, plugin: &str) -> bool {
    list.as_array()
        .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(plugin)))
}

/// Ask the daemon (if there is one) for every paired device that offers its
/// storage. Reads only; starts nothing.
pub async fn read(conn: &Connection) -> Vec<Phone> {
    let Some(to) = owner(conn).await else {
        return Vec::new();
    };
    // devices(onlyReachable = false, onlyPaired = true)
    let ids = call(conn, &to, ANSWER, ROOT, DAEMON, "devices", &(false, true))
        .await
        .unwrap_or(Json::Null);
    let mut out = Vec::new();
    for id in ids
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
    {
        if !element_ok(id) {
            continue;
        }
        let path = format!("{ROOT}/devices/{id}");
        let Some(p) = props(conn, &to, &path).await else {
            continue;
        };
        // what it offered when last seen: a paired computer has no storage to open
        if !has(p.get("supportedPlugins").unwrap_or(&Json::Null), STORAGE) {
            continue;
        }
        let flag = |k: &str| p.get(k).and_then(Json::as_bool).unwrap_or(false);
        let mut phone = Phone {
            id: id.to_string(),
            name: tidy(p.get("name").and_then(Json::as_str).unwrap_or(""), "Phone"),
            ..Phone::default()
        };
        if flag("isReachable") && flag("isPaired") {
            let loaded = call(conn, &to, ANSWER, &path, DEVICE, "loadedPlugins", &())
                .await
                .unwrap_or(Json::Null);
            phone.ready = has(&loaded, STORAGE);
        }
        if phone.ready {
            let sftp = format!("{path}/sftp");
            let ask = |m: &'static str| call(conn, &to, ANSWER, &sftp, SFTP, m, &());
            phone.mounted = ask("isMounted").await.ok().and_then(|v| v.as_bool()) == Some(true);
            if phone.mounted {
                let mount = ask("mountPoint").await.unwrap_or(Json::Null);
                let mount = mount.as_str().unwrap_or("");
                let dirs = ask("getDirectories").await.unwrap_or(Json::Null);
                let mut dirs: Vec<(String, String)> = dirs
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(dir, _)| dir_ok(dir, mount))
                    .map(|(dir, name)| (dir.clone(), tidy(name.as_str().unwrap_or(""), "Storage")))
                    .collect();
                dirs.sort();
                // mounted, and the daemon names no folder: the mount itself
                if dirs.is_empty() && Path::new(mount).is_dir() {
                    dirs.push((mount.to_string(), "Storage".to_string()));
                }
                phone.dirs = dirs;
            }
        }
        out.push(phone);
    }
    out.sort_by_key(|p| p.name.to_lowercase());
    out
}

/// Read again; `devices-changed` when what is shown changed.
async fn refresh(conn: &Connection, emit: &Emit) {
    let next = rows(&read(conn).await);
    let changed = match ROWS.lock() {
        Ok(mut rows) => {
            let changed = *rows != next;
            *rows = next;
            changed
        }
        Err(_) => false,
    };
    if changed {
        emit("devices-changed", Json::Null);
    }
}

static CONN: tokio::sync::OnceCell<Connection> = tokio::sync::OnceCell::const_new();

async fn session() -> Result<&'static Connection, String> {
    CONN.get_or_try_init(|| async { Connection::session().await })
        .await
        .map_err(|e| format!("no session bus: {e}"))
}

/// The signals worth a look: a device came, went or changed, its storage was
/// mounted or unmounted. A phone's battery and its player talk all day.
fn worth_a_look(iface: &str) -> bool {
    matches!(iface, DAEMON | DEVICE | SFTP)
}

/// Keep the rows true for the app's life.
pub fn watch(emit: Emit) {
    tauri::async_runtime::spawn(async move {
        let Ok(conn) = session().await else {
            return; // no session bus: no phones, and nothing to wait for
        };
        if let Err(e) = follow(conn, &emit).await {
            eprintln!("ewe-files-app: phones: {e}");
        }
    });
}

async fn follow(conn: &Connection, emit: &Emit) -> zbus::Result<()> {
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender(SERVICE)?
        .path_namespace(ROOT)?
        .build();
    let mut signals = zbus::MessageStream::for_match_rule(rule, conn, Some(64)).await?;
    // the daemon starting or stopping (it is started by ewe Mobile, the Phone
    // plugin, the session — never by this window)
    let dbus = zbus::fdo::DBusProxy::new(conn).await?;
    let mut owners = dbus
        .receive_name_owner_changed_with_args(&[(0, SERVICE)])
        .await?;
    refresh(conn, emit).await;
    loop {
        tokio::select! {
            msg = signals.next() => {
                let Some(msg) = msg else { break };
                let Ok(msg) = msg else { continue };
                let header = msg.header();
                if !header.interface().is_some_and(|i| worth_a_look(i.as_str())) {
                    continue;
                }
            }
            change = owners.next() => {
                if change.is_none() { break }
            }
        }
        // let the burst pass, then look once
        tokio::time::sleep(SETTLE).await;
        refresh(conn, emit).await;
    }
    Ok(())
}

fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
        .unwrap_or(false)
}

/// Mount the storage of `device` and say which folder to open.
pub async fn mount(conn: &Connection, device: &str) -> Result<String, String> {
    if !element_ok(device) {
        return Err("That phone is gone".into());
    }
    let to = owner(conn)
        .await
        .ok_or("The phone link isn’t running. Open ewe Mobile.")?;
    if !which("sshfs") {
        return Err("Opening a phone needs sshfs. Install it with Komble, then try again.".into());
    }
    let path = format!("{ROOT}/devices/{device}");
    let p = props(conn, &to, &path).await.ok_or("That phone is gone")?;
    let name = tidy(
        p.get("name").and_then(Json::as_str).unwrap_or(""),
        "The phone",
    );
    let flag = |k: &str| p.get(k).and_then(Json::as_bool).unwrap_or(false);
    // the storage object is only there while the phone is in reach and shares
    // its files: say which it is, rather than pass on "no such object"
    if !(flag("isReachable") && flag("isPaired")) {
        return Err(format!(
            "{name} isn’t in reach. Unlock it and check that it is on the same Wi-Fi."
        ));
    }
    let loaded = call(conn, &to, ANSWER, &path, DEVICE, "loadedPlugins", &()).await?;
    if !has(&loaded, STORAGE) {
        return Err(format!(
            "{name} isn’t sharing its files. Allow file access in KDE Connect on the phone."
        ));
    }
    let sftp = format!("{path}/sftp");
    let ok = call(conn, &to, PATIENT, &sftp, SFTP, "mountAndWait", &())
        .await?
        .as_bool()
        == Some(true);
    if !ok {
        let why = call(conn, &to, ANSWER, &sftp, SFTP, "getMountError", &())
            .await
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        return Err(if why.is_empty() {
            format!("Couldn’t open {name}. Unlock it and allow file access in KDE Connect.")
        } else {
            format!("Couldn’t open {name}: {why}")
        });
    }
    let phone = read(conn).await.into_iter().find(|p| p.id == device);
    phone
        .and_then(|p| p.dirs.first().map(|(dir, _)| dir.clone()))
        .filter(|dir| Path::new(dir).is_dir())
        .ok_or_else(|| format!("{name} is connected, but its folder isn’t there yet. Try again."))
}

pub async fn unmount(conn: &Connection, device: &str) -> Result<(), String> {
    if !element_ok(device) {
        return Err("That phone is gone".into());
    }
    let Some(to) = owner(conn).await else {
        return Ok(()); // no daemon, no mount
    };
    let sftp = format!("{ROOT}/devices/{device}/sftp");
    call(conn, &to, ANSWER, &sftp, SFTP, "unmount", &()).await?;
    // the daemon answers before sshfs has let go: wait until it says so
    for _ in 0..20 {
        let still = call(conn, &to, ANSWER, &sftp, SFTP, "isMounted", &()).await;
        if still.ok().and_then(|v| v.as_bool()) != Some(true) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

/// `mount` | `unmount` | `eject` on one of this module's device ids; the
/// answer comes as `device-result`, like GIO's.
pub fn act(id: &str, action: &str, emit: Emit) -> Result<(), String> {
    let device = device_of(id).ok_or("That phone is gone")?.to_string();
    if !matches!(action, "mount" | "unmount" | "eject") {
        return Err("Unknown action".into());
    }
    let (id, action) = (id.to_string(), action.to_string());
    tauri::async_runtime::spawn(async move {
        let done = match session().await {
            Err(e) => Err(e),
            Ok(conn) => {
                let done = if action == "mount" {
                    mount(conn, &device).await.map(Some)
                } else {
                    unmount(conn, &device).await.map(|()| None)
                };
                refresh(conn, &emit).await;
                done
            }
        };
        let action = if action == "eject" {
            "unmount"
        } else {
            action.as_str()
        };
        emit(
            "device-result",
            match done {
                Ok(path) => {
                    serde_json::json!({ "id": id, "action": action, "ok": true, "path": path })
                }
                Err(error) => {
                    serde_json::json!({ "id": id, "action": action, "ok": false, "error": error })
                }
            },
        );
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phone(name: &str) -> Phone {
        Phone {
            id: "abc123".into(),
            name: name.into(),
            ..Phone::default()
        }
    }

    #[test]
    fn a_phone_in_reach_can_be_connected() {
        let p = Phone {
            ready: true,
            ..phone("Pixel")
        };
        let r = rows(&[p]);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "kdc:abc123");
        assert_eq!(r[0].label, "Pixel");
        assert_eq!((r[0].icon, r[0].kind), ("smartphone", "phone"));
        assert!(r[0].can_mount && !r[0].mounted && !r[0].away);
        assert_eq!(r[0].path, None);
        assert!(!r[0].can_eject, "a phone is disconnected, never ejected");
    }

    #[test]
    fn a_phone_that_is_away_stays_as_a_place_that_is_not_there() {
        let r = rows(&[phone("Pixel")]);
        assert_eq!(r.len(), 1);
        assert!(r[0].away && !r[0].can_mount && !r[0].mounted);
    }

    #[test]
    fn a_mounted_phone_is_a_row_per_folder() {
        let p = Phone {
            ready: true,
            mounted: true,
            dirs: vec![
                (
                    "/run/user/1000/abc123/storage/emulated/0".into(),
                    "Internal shared storage".into(),
                ),
                (
                    "/run/user/1000/abc123/storage/1A2B-3C4D".into(),
                    "SD card".into(),
                ),
            ],
            ..phone("Pixel")
        };
        let r = rows(&[p]);
        assert_eq!(r.len(), 2);
        assert_eq!(
            (r[0].id.as_str(), r[0].label.as_str()),
            ("kdc:abc123", "Pixel")
        );
        assert_eq!(
            r[0].path.as_deref(),
            Some("/run/user/1000/abc123/storage/emulated/0")
        );
        assert_eq!(
            (r[1].id.as_str(), r[1].label.as_str()),
            ("kdc:abc123/1", "Pixel · SD card")
        );
        assert!(
            r.iter()
                .all(|d| d.mounted && d.can_unmount && !d.can_mount && !d.away)
        );
        // both rows are the same phone to Disconnect
        assert_eq!(device_of(&r[1].id), Some("abc123"));
    }

    #[test]
    fn mounted_with_no_folder_named_is_still_one_row() {
        let p = Phone {
            ready: true,
            mounted: true,
            ..phone("Pixel")
        };
        let r = rows(&[p]);
        assert_eq!(r.len(), 1);
        assert!(r[0].mounted && r[0].path.is_none());
    }

    #[test]
    fn only_this_modules_ids_and_only_bus_safe_ones() {
        assert_eq!(
            device_of("kdc:be62e5e5525a44ad8a97f8785da67233"),
            Some("be62e5e5525a44ad8a97f8785da67233")
        );
        assert_eq!(device_of("kdc:a_b/2"), Some("a_b"));
        assert_eq!(device_of("vol:uuid:1234"), None);
        assert_eq!(device_of("kdc:"), None);
        assert_eq!(device_of("kdc:../x"), None);
        assert_eq!(device_of("kdc:a-b"), None);
    }

    #[test]
    fn a_folder_is_only_taken_inside_the_phones_mount() {
        let m = "/run/user/1000/abc123";
        assert!(dir_ok("/run/user/1000/abc123/storage/emulated/0", m));
        assert!(dir_ok("/run/user/1000/abc123", m));
        assert!(!dir_ok("/run/user/1000/abc123/../../../home/you", m));
        assert!(!dir_ok("/home/you", m));
        assert!(
            !dir_ok("/run/user/1000/abc1234", m),
            "a sibling is not inside"
        );
        assert!(!dir_ok("storage/emulated/0", m));
        assert!(!dir_ok("/x", ""));
    }

    #[test]
    fn a_name_from_the_phone_is_one_short_line() {
        assert_eq!(tidy("Pixel 10 Pro XL", "Phone"), "Pixel 10 Pro XL");
        assert_eq!(tidy("  two\nlines\t here ", "Phone"), "two lines here");
        assert_eq!(tidy("", "Phone"), "Phone");
        assert_eq!(tidy("\u{7}", "Phone"), "Phone");
        assert_eq!(tidy(&"x".repeat(200), "Phone").chars().count(), 64);
        assert_eq!(tidy("ნინოს ტელეფონი", "Phone"), "ნინოს ტელეფონი");
    }

    #[test]
    fn only_some_signals_are_worth_a_look() {
        assert!(worth_a_look("org.kde.kdeconnect.daemon"));
        assert!(worth_a_look("org.kde.kdeconnect.device"));
        assert!(worth_a_look("org.kde.kdeconnect.device.sftp"));
        assert!(!worth_a_look("org.kde.kdeconnect.device.battery"));
        assert!(!worth_a_look("org.kde.kdeconnect.device.mprisremote"));
    }

    /// A stand-in for kdeconnectd: one phone in reach that mounts into the
    /// folder named by argv[1], one that is away, one paired computer (no
    /// storage). `mountAndWait` creates "Internal shared storage" there.
    const DAEMON_PY: &str = r#"
import os, sys, dbus, dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib
DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
name = dbus.service.BusName("org.kde.kdeconnect", bus)
ROOT = "/modules/kdeconnect"
MOUNT = sys.argv[1]
PROPS = "org.freedesktop.DBus.Properties"
ALL = ["kdeconnect_sftp", "kdeconnect_battery"]
class Daemon(dbus.service.Object):
    @dbus.service.method("org.kde.kdeconnect.daemon", in_signature="bb", out_signature="as")
    def devices(self, reachable, paired):
        return ["here1", "away2", "desk3"]
class Device(dbus.service.Object):
    def __init__(self, path, name, reachable, plugins):
        super().__init__(bus, path)
        self.p = {"name": name, "type": "phone", "isReachable": reachable, "isPaired": True,
                  "supportedPlugins": dbus.Array(plugins, signature="s")}
        self.loaded = plugins if reachable else []
    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, iface):
        return self.p
    @dbus.service.method("org.kde.kdeconnect.device", out_signature="as")
    def loadedPlugins(self):
        return dbus.Array(self.loaded, signature="s")
class Sftp(dbus.service.Object):
    up = False
    @dbus.service.method("org.kde.kdeconnect.device.sftp", out_signature="b")
    def isMounted(self):
        return self.up
    @dbus.service.method("org.kde.kdeconnect.device.sftp", out_signature="s")
    def mountPoint(self):
        return MOUNT
    @dbus.service.method("org.kde.kdeconnect.device.sftp", out_signature="b")
    def mountAndWait(self):
        os.makedirs(MOUNT + "/storage/emulated/0/DCIM", exist_ok=True)
        self.up = True
        self.mounted()
        return True
    @dbus.service.method("org.kde.kdeconnect.device.sftp", out_signature="a{sv}")
    def getDirectories(self):
        if not self.up:
            return dbus.Dictionary({}, signature="sv")
        return {MOUNT + "/storage/emulated/0": "Internal shared storage",
                MOUNT + "/../../outside": "Not a folder of this phone"}
    @dbus.service.method("org.kde.kdeconnect.device.sftp", out_signature="s")
    def getMountError(self):
        return ""
    @dbus.service.method("org.kde.kdeconnect.device.sftp")
    def unmount(self):
        self.up = False
        self.unmounted()
    @dbus.service.signal("org.kde.kdeconnect.device.sftp")
    def mounted(self): pass
    @dbus.service.signal("org.kde.kdeconnect.device.sftp")
    def unmounted(self): pass
keep = [Daemon(bus, ROOT),
        Device(ROOT + "/devices/here1", "Stand-in\nPixel", True, ALL),
        Device(ROOT + "/devices/away2", "Away Phone", False, ALL),
        Device(ROOT + "/devices/desk3", "A computer", True, ["kdeconnect_battery"]),
        Sftp(bus, ROOT + "/devices/here1/sftp")]
GLib.MainLoop().run()
"#;

    /// The whole path on a private bus — run by `scripts/test-phones.sh`, and
    /// refusing to run anywhere else (the stand-in takes the real daemon's
    /// name). First with nobody home: an empty bus stays empty, kdeconnectd
    /// is NOT started by looking. Then with the stand-in: the phones, the
    /// mount, the folder guard, the unmount.
    #[test]
    #[ignore = "run through scripts/test-phones.sh (a private session bus)"]
    fn private_bus_phones() {
        use std::process::{Command, Stdio};
        assert_eq!(
            std::env::var("EWE_FILES_TEST_BUS").as_deref(),
            Ok("private"),
            "run scripts/test-phones.sh — this must never run on the real session bus"
        );
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("here1");
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let conn = Connection::session().await.unwrap();
            // nobody home: nothing to show, and nobody started
            assert_eq!(read(&conn).await, Vec::new());
            assert!(mount_err(&conn, "here1").await.contains("isn’t running"));
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(
                owner(&conn).await.is_none(),
                "looking for phones started the daemon"
            );

            let mut daemon = Command::new("python3")
                .args(["-c", DAEMON_PY, at.to_str().unwrap()])
                .stdin(Stdio::null())
                .spawn()
                .expect("python3 with dbus and gi");
            for _ in 0..50 {
                if owner(&conn).await.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(
                owner(&conn).await.is_some(),
                "the stand-in never took its name"
            );

            // two phones (the computer offers no storage), by name
            let phones = read(&conn).await;
            let names: Vec<&str> = phones.iter().map(|p| p.name.as_str()).collect();
            assert_eq!(names, ["Away Phone", "Stand-in Pixel"]);
            assert!(!phones[0].ready && phones[1].ready && !phones[1].mounted);

            // the one that is away says so; an id that is not one never reaches the bus
            assert!(mount_err(&conn, "away2").await.contains("isn’t in reach"));
            assert!(mount(&conn, "../x").await.is_err());

            // Connect: the folder to open, and only the folder inside the mount
            let opened = mount(&conn, "here1").await.unwrap();
            assert_eq!(opened, format!("{}/storage/emulated/0", at.display()));
            let phones = read(&conn).await;
            let here = phones.iter().find(|p| p.id == "here1").unwrap();
            assert!(here.mounted);
            assert_eq!(here.dirs.len(), 1, "a folder outside the mount was taken");
            assert_eq!(here.dirs[0].1, "Internal shared storage");
            let r = rows(&phones);
            assert_eq!(r.iter().filter(|d| d.mounted).count(), 1);

            // Disconnect
            unmount(&conn, "here1").await.unwrap();
            assert!(!read(&conn).await.iter().any(|p| p.mounted));

            let _ = daemon.kill();
            let _ = daemon.wait();
        });
    }

    async fn mount_err(conn: &Connection, device: &str) -> String {
        mount(conn, device).await.unwrap_err()
    }

    /// Reads the real daemon — counts and states only, nothing is mounted.
    ///   cargo test -p ewe-files-app live_phones -- --ignored --nocapture
    #[test]
    #[ignore = "needs a running kdeconnectd with a paired phone"]
    fn live_phones() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let conn = Connection::session().await.unwrap();
            assert!(owner(&conn).await.is_some(), "kdeconnectd is not running");
            let phones = read(&conn).await;
            for p in &phones {
                println!(
                    "phone: ready={} mounted={} folders={}",
                    p.ready,
                    p.mounted,
                    p.dirs.len()
                );
            }
            assert!(!phones.is_empty(), "no paired phone offers its storage");
            assert!(rows(&phones).iter().all(|d| d.id.starts_with(PREFIX)));
        });
    }

    /// Connect and Disconnect against the real phone: mounts its storage,
    /// counts what is in the folder it names, and unmounts again. Prints
    /// counts, never names. The phone must be in reach and unlocked.
    ///   cargo test -p ewe-files-app live_mount -- --ignored --nocapture
    #[test]
    #[ignore = "mounts a real phone's storage (and unmounts it)"]
    fn live_mount() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let conn = Connection::session().await.unwrap();
            let phones = read(&conn).await;
            let p = phones
                .iter()
                .find(|p| p.ready)
                .expect("no paired phone is in reach");
            assert!(!p.mounted, "it is mounted already: someone is using it");
            let dir = mount(&conn, &p.id).await.expect("the phone did not mount");
            let entries = std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0);
            let after = read(&conn).await;
            let now = after.iter().find(|x| x.id == p.id).unwrap();
            println!(
                "mounted: folders={} entries in the first={} rows={}",
                now.dirs.len(),
                entries,
                rows(&after).iter().filter(|d| d.mounted).count()
            );
            assert!(now.mounted && !now.dirs.is_empty());
            assert_eq!(now.dirs[0].0, dir);
            assert!(entries > 0, "the phone's folder is empty");
            unmount(&conn, &p.id).await.unwrap();
            let after = read(&conn).await;
            assert!(!after.iter().any(|x| x.id == p.id && x.mounted));
            println!("unmounted");
        });
    }
}
