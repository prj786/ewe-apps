//! Drives, phones, cards and network shares through GIO's volume monitor (main
//! thread only: GIO objects are not `Send`). Mount / unmount / eject run async on
//! the GLib main loop and report through `device-result`; credentials are asked
//! through `mount-ask` and answered with [`mount_reply`].

use std::cell::RefCell;
use std::collections::HashMap;

use gio::prelude::*;
use serde::Serialize;

use crate::ops::Emit;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub label: String,
    /// `usb` | `hard-drive` | `disc` | `smartphone` | `server` | `cloud`
    pub icon: &'static str,
    /// `drive` | `phone` | `optical` | `network`
    pub kind: &'static str,
    /// the local (or FUSE) path while mounted
    pub path: Option<String>,
    pub uri: Option<String>,
    pub mounted: bool,
    pub can_mount: bool,
    pub can_unmount: bool,
    pub can_eject: bool,
    pub removable: bool,
    pub size: Option<u64>,
}

thread_local! {
    static MONITOR: RefCell<Option<gio::VolumeMonitor>> = const { RefCell::new(None) };
    static PENDING: RefCell<HashMap<u64, gio::MountOperation>> = RefCell::new(HashMap::new());
    static NEXT_ASK: RefCell<u64> = const { RefCell::new(1) };
}

/// Start watching; `devices-changed` fires on every change.
pub fn init(emit: Emit) {
    let monitor = gio::VolumeMonitor::get();
    for signal in [
        "volume-added",
        "volume-removed",
        "volume-changed",
        "mount-added",
        "mount-removed",
        "mount-changed",
        "drive-connected",
        "drive-disconnected",
        "drive-changed",
    ] {
        let emit = emit.clone();
        monitor.connect_local(signal, false, move |_| {
            emit("devices-changed", serde_json::Value::Null);
            None
        });
    }
    MONITOR.with(|m| *m.borrow_mut() = Some(monitor));
}

fn icon_name(icon: Option<gio::Icon>) -> String {
    icon.and_then(|i| i.downcast::<gio::ThemedIcon>().ok())
        .map(|t| {
            t.names()
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

fn classify(icon: &str, uri: Option<&str>) -> (&'static str, &'static str) {
    let scheme = uri.and_then(|u| u.split_once("://")).map(|(s, _)| s);
    match scheme {
        Some("mtp") | Some("gphoto2") | Some("afc") => return ("smartphone", "phone"),
        Some("smb") | Some("sftp") | Some("ftp") | Some("ftps") | Some("dav") | Some("davs")
        | Some("nfs") | Some("afp") => return ("server", "network"),
        Some("google-drive") | Some("onedrive") => return ("cloud", "network"),
        _ => {}
    }
    if icon.contains("phone") || icon.contains("multimedia-player") || icon.contains("camera") {
        ("smartphone", "phone")
    } else if icon.contains("optical") || icon.contains("cdrom") || icon.contains("dvd") {
        ("disc", "optical")
    } else if icon.contains("network") || icon.contains("server") || icon.contains("remote") {
        ("server", "network")
    } else if icon.contains("usb") || icon.contains("removable") || icon.contains("flash") {
        ("usb", "drive")
    } else {
        ("hard-drive", "drive")
    }
}

fn volume_id(v: &gio::Volume) -> String {
    for kind in ["uuid", "unix-device", "label"] {
        if let Some(id) = v.identifier(kind) {
            return format!("vol:{kind}:{id}");
        }
    }
    format!("vol:name:{}", v.name())
}

fn mount_id(m: &gio::Mount) -> String {
    format!("mnt:{}", m.root().uri())
}

fn mount_path(m: &gio::Mount) -> Option<String> {
    m.root().path().map(|p| p.to_string_lossy().into_owned())
}

/// Every volume (mounted or not) and every mount without a volume (network, MTP).
pub fn list() -> Vec<Device> {
    let Some(monitor) = MONITOR.with(|m| m.borrow().clone()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen_mounts = Vec::new();
    for v in monitor.volumes() {
        let mount = v.get_mount();
        let uri = v
            .activation_root()
            .map(|f| f.uri().to_string())
            .or_else(|| mount.as_ref().map(|m| m.root().uri().to_string()));
        let icon = icon_name(Some(v.icon()));
        let (glyph, kind) = classify(&icon, uri.as_deref());
        let drive = v.drive();
        let removable = drive
            .as_ref()
            .map(|d| d.is_removable() || d.is_media_removable())
            .unwrap_or(kind != "drive");
        let size = v
            .identifier("unix-device")
            .and_then(|dev| {
                std::fs::read_to_string(format!(
                    "/sys/class/block/{}/size",
                    dev.trim_start_matches("/dev/")
                ))
                .ok()
            })
            .and_then(|s| s.trim().parse::<u64>().ok())
            .map(|sectors| sectors * 512);
        if let Some(m) = &mount {
            seen_mounts.push(m.root().uri().to_string());
        }
        out.push(Device {
            id: volume_id(&v),
            label: v.name().to_string(),
            icon: glyph,
            kind,
            path: mount.as_ref().and_then(mount_path),
            uri,
            mounted: mount.is_some(),
            can_mount: mount.is_none() && v.can_mount(),
            can_unmount: mount.as_ref().map(|m| m.can_unmount()).unwrap_or(false),
            can_eject: v.can_eject() || drive.as_ref().map(|d| d.can_eject()).unwrap_or(false),
            removable,
            size,
        });
    }
    for m in monitor.mounts() {
        let uri = m.root().uri().to_string();
        if seen_mounts.contains(&uri) || m.is_shadowed() {
            continue;
        }
        let icon = icon_name(Some(m.icon()));
        let (glyph, kind) = classify(&icon, Some(&uri));
        out.push(Device {
            id: mount_id(&m),
            label: m.name().to_string(),
            icon: glyph,
            kind,
            path: mount_path(&m),
            uri: Some(uri),
            mounted: true,
            can_mount: false,
            can_unmount: m.can_unmount(),
            can_eject: m.can_eject(),
            removable: true,
            size: None,
        });
    }
    out
}

fn find_volume(monitor: &gio::VolumeMonitor, id: &str) -> Option<gio::Volume> {
    monitor.volumes().into_iter().find(|v| volume_id(v) == id)
}

fn find_mount(monitor: &gio::VolumeMonitor, id: &str) -> Option<gio::Mount> {
    if let Some(v) = find_volume(monitor, id) {
        return v.get_mount();
    }
    monitor.mounts().into_iter().find(|m| mount_id(m) == id)
}

fn result(emit: &Emit, id: &str, action: &str, r: Result<Option<String>, glib::Error>) {
    let v = match r {
        Ok(path) => serde_json::json!({ "id": id, "action": action, "ok": true, "path": path }),
        Err(e) => {
            let text = e.message().to_string();
            let cancelled = e.matches(gio::IOErrorEnum::FailedHandled)
                || e.matches(gio::IOErrorEnum::Cancelled);
            serde_json::json!({ "id": id, "action": action, "ok": false, "cancelled": cancelled, "error": text })
        }
    };
    emit("device-result", v);
}

/// A mount operation whose questions go to the webview as `mount-ask`.
fn operation(emit: Emit) -> gio::MountOperation {
    let op = gio::MountOperation::new();
    let ask_id = NEXT_ASK.with(|n| {
        let mut n = n.borrow_mut();
        let id = *n;
        *n += 1;
        id
    });
    PENDING.with(|p| p.borrow_mut().insert(ask_id, op.clone()));
    let e = emit.clone();
    op.connect_ask_password(move |_op, message, default_user, default_domain, flags| {
        e(
            "mount-ask",
            serde_json::json!({
                "id": ask_id,
                "message": message,
                "defaultUser": default_user,
                "defaultDomain": default_domain,
                "needsPassword": flags.contains(gio::AskPasswordFlags::NEED_PASSWORD),
                "needsUsername": flags.contains(gio::AskPasswordFlags::NEED_USERNAME),
                "needsDomain": flags.contains(gio::AskPasswordFlags::NEED_DOMAIN),
                "anonymousOk": flags.contains(gio::AskPasswordFlags::ANONYMOUS_SUPPORTED),
                "canRemember": flags.contains(gio::AskPasswordFlags::SAVING_SUPPORTED),
            }),
        );
    });
    let e = emit;
    op.connect_local("ask-question", false, move |args| {
        let message: String = args
            .get(1)
            .and_then(|m| m.get::<String>().ok())
            .unwrap_or_default();
        let choices: Vec<String> = args
            .get(2)
            .and_then(|c| c.get::<Vec<String>>().ok())
            .unwrap_or_default();
        e(
            "mount-question",
            serde_json::json!({ "id": ask_id, "message": message, "choices": choices }),
        );
        None
    });
    op
}

/// What the webview answered to `mount-ask` / `mount-question`.
pub struct Reply {
    pub cancel: bool,
    pub username: Option<String>,
    pub password: Option<String>,
    pub domain: Option<String>,
    pub anonymous: bool,
    pub remember: bool,
    pub choice: Option<i32>,
}

pub fn mount_reply(ask_id: u64, reply: Reply) -> bool {
    let Some(op) = PENDING.with(|p| p.borrow().get(&ask_id).cloned()) else {
        return false;
    };
    if reply.cancel {
        op.reply(gio::MountOperationResult::Aborted);
        return true;
    }
    if let Some(c) = reply.choice {
        op.set_choice(c);
    }
    if let Some(u) = reply.username {
        op.set_username(Some(&u));
    }
    if let Some(p) = reply.password {
        op.set_password(Some(&p));
    }
    if let Some(d) = reply.domain {
        op.set_domain(Some(&d));
    }
    op.set_anonymous(reply.anonymous);
    op.set_password_save(if reply.remember {
        gio::PasswordSave::Permanently
    } else {
        gio::PasswordSave::Never
    });
    op.reply(gio::MountOperationResult::Handled);
    true
}

fn forget(op: &gio::MountOperation) {
    PENDING.with(|p| p.borrow_mut().retain(|_, o| o != op));
}

/// `mount` | `unmount` | `eject` on a device id; the answer comes as `device-result`.
pub fn act(id: &str, action: &str, emit: Emit) -> Result<(), String> {
    let monitor = MONITOR
        .with(|m| m.borrow().clone())
        .ok_or("Devices are not available")?;
    let op = operation(emit.clone());
    let id_owned = id.to_string();
    let action_owned = action.to_string();
    match action {
        "mount" => {
            let v = find_volume(&monitor, id).ok_or("That drive is gone")?;
            let op2 = op.clone();
            let v2 = v.clone();
            v.mount(
                gio::MountMountFlags::NONE,
                Some(&op),
                None::<&gio::Cancellable>,
                move |r| {
                    forget(&op2);
                    let path = v2.get_mount().and_then(|m| mount_path(&m));
                    result(&emit, &id_owned, &action_owned, r.map(|()| path));
                },
            );
        }
        "unmount" => {
            let m = find_mount(&monitor, id).ok_or("It is not mounted")?;
            let op2 = op.clone();
            m.unmount_with_operation(
                gio::MountUnmountFlags::NONE,
                Some(&op),
                None::<&gio::Cancellable>,
                move |r| {
                    forget(&op2);
                    result(&emit, &id_owned, &action_owned, r.map(|()| None));
                },
            );
        }
        "eject" => {
            let op2 = op.clone();
            let done = move |r: Result<(), glib::Error>| {
                forget(&op2);
                result(&emit, &id_owned, &action_owned, r.map(|()| None));
            };
            if let Some(v) = find_volume(&monitor, id) {
                if v.can_eject() {
                    v.eject_with_operation(
                        gio::MountUnmountFlags::NONE,
                        Some(&op),
                        None::<&gio::Cancellable>,
                        done,
                    );
                } else if let Some(d) = v.drive().filter(|d| d.can_eject()) {
                    d.eject_with_operation(
                        gio::MountUnmountFlags::NONE,
                        Some(&op),
                        None::<&gio::Cancellable>,
                        done,
                    );
                } else if let Some(m) = v.get_mount() {
                    m.unmount_with_operation(
                        gio::MountUnmountFlags::NONE,
                        Some(&op),
                        None::<&gio::Cancellable>,
                        done,
                    );
                } else {
                    return Err("It cannot be ejected".into());
                }
            } else {
                let m = find_mount(&monitor, id).ok_or("That drive is gone")?;
                if m.can_eject() {
                    m.eject_with_operation(
                        gio::MountUnmountFlags::NONE,
                        Some(&op),
                        None::<&gio::Cancellable>,
                        done,
                    );
                } else {
                    m.unmount_with_operation(
                        gio::MountUnmountFlags::NONE,
                        Some(&op),
                        None::<&gio::Cancellable>,
                        done,
                    );
                }
            }
        }
        _ => return Err("Unknown action".into()),
    }
    Ok(())
}

/// "Connect to server…": mount `uri` (smb://, sftp://, ftp://, davs://, …); the
/// answer is `device-result {id: uri, action: "connect", path}`.
pub fn connect(uri: &str, emit: Emit) -> Result<(), String> {
    let trimmed = uri.trim();
    if !trimmed.contains("://") {
        return Err("Type an address like smb://server/share or sftp://user@host".into());
    }
    let scheme = trimmed.split_once("://").map(|(s, _)| s).unwrap_or("");
    if ![
        "smb", "sftp", "ssh", "ftp", "ftps", "dav", "davs", "nfs", "afp", "mtp", "gphoto2",
    ]
    .contains(&scheme)
    {
        return Err(format!(
            "{scheme}:// is not a kind of server ewe Files can connect to"
        ));
    }
    let file = gio::File::for_uri(trimmed);
    let op = operation(emit.clone());
    let op2 = op.clone();
    let id = trimmed.to_string();
    let file2 = file.clone();
    file.mount_enclosing_volume(
        gio::MountMountFlags::NONE,
        Some(&op),
        None::<&gio::Cancellable>,
        move |r| {
            forget(&op2);
            let path = file2.path().map(|p| p.to_string_lossy().into_owned());
            let r = match r {
                // already mounted is as good as mounted
                Err(e) if e.matches(gio::IOErrorEnum::AlreadyMounted) => Ok(()),
                other => other,
            };
            result(&emit, &id, "connect", r.map(|()| path));
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_icons_and_uris() {
        assert_eq!(
            classify("drive-removable-media-usb", None),
            ("usb", "drive")
        );
        assert_eq!(classify("drive-harddisk", None), ("hard-drive", "drive"));
        assert_eq!(classify("media-optical", None), ("disc", "optical"));
        assert_eq!(
            classify("phone", Some("mtp://[usb:001,004]/")),
            ("smartphone", "phone")
        );
        assert_eq!(
            classify("folder-remote", Some("smb://nas/share")),
            ("server", "network")
        );
        assert_eq!(
            classify("x", Some("google-drive://a@b/")),
            ("cloud", "network")
        );
    }
}
