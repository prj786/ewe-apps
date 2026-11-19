//! Keep the screen awake while a video plays: `org.freedesktop.ScreenSaver.Inhibit` on the
//! session bus. hypridle serves that interface in ewe (`ignore_dbus_inhibit = false` in
//! `dotfiles/hypr/hypridle.conf`), so one cookie holds off dim, lock and suspend.

use std::sync::{Arc, Mutex};

use mpris_server::zbus;

#[derive(Clone, Default)]
pub struct Inhibitor {
    cookie: Arc<Mutex<Option<u32>>>,
}

const DEST: &str = "org.freedesktop.ScreenSaver";
const PATH: &str = "/org/freedesktop/ScreenSaver";

impl Inhibitor {
    /// Turn the inhibit on or off; idempotent. Errors (no bus, no hypridle) are reported
    /// as text so the webview can say "Could not keep the screen awake".
    pub async fn set(&self, on: bool) -> Result<bool, String> {
        let current = *self.cookie.lock().unwrap();
        match (on, current) {
            (true, Some(_)) => Ok(true),
            (false, None) => Ok(false),
            (true, None) => {
                let conn = zbus::Connection::session()
                    .await
                    .map_err(|e| e.to_string())?;
                let reply = conn
                    .call_method(
                        Some(DEST),
                        PATH,
                        Some(DEST),
                        "Inhibit",
                        &("ewe Player", "Playing a video"),
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                let cookie: u32 = reply.body().deserialize().map_err(|e| e.to_string())?;
                *self.cookie.lock().unwrap() = Some(cookie);
                Ok(true)
            }
            (false, Some(cookie)) => {
                *self.cookie.lock().unwrap() = None;
                let conn = zbus::Connection::session()
                    .await
                    .map_err(|e| e.to_string())?;
                conn.call_method(Some(DEST), PATH, Some(DEST), "UnInhibit", &(cookie,))
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(false)
            }
        }
    }
}
