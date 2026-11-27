//! When an ewe app panics, say why in the journal before it is gone.
//!
//! The release build aborts on a panic (`panic = "abort"`), and a desktop app's
//! stderr goes nowhere: all the owner sees is a window that vanished.
//! `journalctl -t ewe-files-app -p crit` (the binary's name) now has the sentence
//! and the place.

use std::os::unix::net::UnixDatagram;
use std::path::Path;

const JOURNAL: &str = "/run/systemd/journal/socket";

/// Keep the default hook (stderr, for a run from a terminal) and add a line in the
/// journal under the app's binary name. Call it first thing in the app's `run`.
pub fn log_panics(id: &'static str, version: &'static str) {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        send(
            Path::new(JOURNAL),
            &entry(id, &format!("{id} {version}: {info}")),
        );
        default(info);
    }));
}

/// One datagram in the journal's native protocol. Nothing here may fail loudly: it
/// runs while the app is already going down.
fn send(socket: &Path, datagram: &str) {
    if let Ok(sock) = UnixDatagram::unbound() {
        let _ = sock.send_to(datagram.as_bytes(), socket);
    }
}

/// A value with a newline needs the protocol's binary form, so the message goes out
/// as one line.
fn entry(id: &str, message: &str) -> String {
    let line = message.replace('\n', " | ");
    format!("PRIORITY=2\nSYSLOG_IDENTIFIER={id}\nMESSAGE={line}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_is_three_fields_and_one_line_of_message() {
        let e = entry(
            "ewe-viewer",
            "ewe-viewer 0.5.1-beta: panicked at src/lib.rs:1:1:\nboom",
        );
        assert_eq!(
            e,
            "PRIORITY=2\nSYSLOG_IDENTIFIER=ewe-viewer\nMESSAGE=ewe-viewer 0.5.1-beta: panicked at src/lib.rs:1:1: | boom\n"
        );
    }

    /// The real socket is the owner's journal: the test listens on its own.
    #[test]
    fn the_entry_arrives_as_one_datagram() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        let listener = UnixDatagram::bind(&path).unwrap();
        let sent = entry("ewe-player", "boom");
        send(&path, &sent);
        let mut buf = [0u8; 256];
        let n = listener.recv(&mut buf).unwrap();
        assert_eq!(std::str::from_utf8(&buf[..n]).unwrap(), sent);
    }

    #[test]
    fn a_journal_that_is_not_there_is_not_an_error() {
        send(Path::new("/nonexistent/journal/socket"), "PRIORITY=2\n");
    }
}
