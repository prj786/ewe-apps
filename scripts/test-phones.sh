#!/usr/bin/env bash
# Paired phones in ewe Files, against a stand-in for KDE Connect's daemon.
#
# On a private session bus (dbus-run-session — never the real one):
#   1. nobody owns org.kde.kdeconnect: ewe Files finds no phones, and looking
#      must NOT start kdeconnectd (the bus would start it for any method call
#      to its name — a file manager that did that would put a new device on
#      the network just by opening);
#   2. a stand-in daemon with a phone in reach, a phone that is away and a
#      paired computer: the two phones are listed, Connect mounts and names
#      the folder to open, a folder outside the phone's mount is refused,
#      Disconnect unmounts.
# The code under test is apps/files/src-tauri/src/phones.rs.
#
#   scripts/test-phones.sh
#
# Needs dbus-run-session and python's dbus + gi (both on every ewe machine);
# without them it says so and exits 0.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v dbus-run-session >/dev/null || { echo "skip  no dbus-run-session"; exit 0; }
python3 -c 'import dbus, gi' 2>/dev/null || { echo "skip  python dbus/gi missing"; exit 0; }
exec dbus-run-session -- env EWE_FILES_TEST_BUS=private \
  cargo test -p ewe-files-app private_bus_phones -- --ignored --nocapture
