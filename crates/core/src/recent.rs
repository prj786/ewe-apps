//! `$XDG_DATA_HOME/recently-used.xbel`, written the way GTK's GtkRecentManager does,
//! so ewe Browser's Home, GTK file dialogs and the shell see what the apps opened.
//! The file is parsed, the entry for the URI is bumped (or added), entries older
//! than GTK's default max age (30 days) are dropped, and the whole thing is written
//! back atomically with mode 0600.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

pub const MAX_AGE_DAYS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Application {
    pub name: String,
    pub exec: String,
    pub modified: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bookmark {
    pub href: String,
    pub added: String,
    pub modified: String,
    pub visited: String,
    pub mime: Option<String>,
    pub title: Option<String>,
    pub desc: Option<String>,
    pub private: bool,
    pub groups: Vec<String>,
    pub applications: Vec<Application>,
}

pub fn xbel_path() -> PathBuf {
    crate::xdg::data_home().join("recently-used.xbel")
}

fn stamp(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
}

fn parse_stamp(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

pub fn parse(text: &str) -> Vec<Bookmark> {
    let Ok(doc) = roxmltree::Document::parse(text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for node in doc
        .root_element()
        .children()
        .filter(|n| n.has_tag_name("bookmark"))
    {
        let attr = |name: &str| node.attribute(name).unwrap_or("").to_string();
        let href = attr("href");
        if href.is_empty() {
            continue;
        }
        let mut b = Bookmark {
            href,
            added: attr("added"),
            modified: attr("modified"),
            visited: attr("visited"),
            mime: None,
            title: None,
            desc: None,
            private: false,
            groups: Vec::new(),
            applications: Vec::new(),
        };
        for child in node.children() {
            match child.tag_name().name() {
                "title" => b.title = child.text().map(str::to_string),
                "desc" => b.desc = child.text().map(str::to_string),
                "info" => {
                    for meta in child.children().filter(|n| n.has_tag_name("metadata")) {
                        for item in meta.children() {
                            match item.tag_name().name() {
                                "mime-type" => b.mime = item.attribute("type").map(str::to_string),
                                "private" => b.private = true,
                                "groups" => {
                                    b.groups = item
                                        .children()
                                        .filter(|n| n.has_tag_name("group"))
                                        .filter_map(|n| n.text().map(str::to_string))
                                        .collect()
                                }
                                "applications" => {
                                    b.applications = item
                                        .children()
                                        .filter(|n| n.has_tag_name("application"))
                                        .map(|n| Application {
                                            name: n.attribute("name").unwrap_or("").to_string(),
                                            exec: n.attribute("exec").unwrap_or("").to_string(),
                                            modified: n
                                                .attribute("modified")
                                                .unwrap_or("")
                                                .to_string(),
                                            count: n
                                                .attribute("count")
                                                .and_then(|c| c.parse().ok())
                                                .unwrap_or(1),
                                        })
                                        .collect()
                                }
                                _ => {}
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        out.push(b);
    }
    out
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn render(items: &[Bookmark]) -> String {
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<xbel version=\"1.0\"\n      xmlns:bookmark=\"http://www.freedesktop.org/standards/desktop-bookmarks\"\n      xmlns:mime=\"http://www.freedesktop.org/standards/shared-mime-info\"\n>\n",
    );
    for b in items {
        s.push_str(&format!(
            "  <bookmark href=\"{}\" added=\"{}\" modified=\"{}\" visited=\"{}\">\n",
            esc(&b.href),
            esc(&b.added),
            esc(&b.modified),
            esc(&b.visited)
        ));
        if let Some(t) = &b.title {
            s.push_str(&format!("    <title>{}</title>\n", esc(t)));
        }
        if let Some(d) = &b.desc {
            s.push_str(&format!("    <desc>{}</desc>\n", esc(d)));
        }
        s.push_str("    <info>\n      <metadata owner=\"http://freedesktop.org\">\n");
        if let Some(m) = &b.mime {
            s.push_str(&format!("        <mime:mime-type type=\"{}\"/>\n", esc(m)));
        }
        if !b.groups.is_empty() {
            s.push_str("        <bookmark:groups>\n");
            for g in &b.groups {
                s.push_str(&format!(
                    "          <bookmark:group>{}</bookmark:group>\n",
                    esc(g)
                ));
            }
            s.push_str("        </bookmark:groups>\n");
        }
        if b.private {
            s.push_str("        <bookmark:private/>\n");
        }
        s.push_str("        <bookmark:applications>\n");
        for a in &b.applications {
            s.push_str(&format!(
                "          <bookmark:application name=\"{}\" exec=\"{}\" modified=\"{}\" count=\"{}\"/>\n",
                esc(&a.name),
                esc(&a.exec),
                esc(&a.modified),
                a.count
            ));
        }
        s.push_str(
            "        </bookmark:applications>\n      </metadata>\n    </info>\n  </bookmark>\n",
        );
    }
    s.push_str("</xbel>\n");
    s
}

/// The real operation: read, bump, write. `app_binary` is what `Exec` would run.
pub fn add(
    xbel: &Path,
    path: &Path,
    mime: Option<&str>,
    app_name: &str,
    app_binary: &str,
    now: DateTime<Utc>,
) -> std::io::Result<()> {
    let existing = std::fs::read_to_string(xbel)
        .map(|t| parse(&t))
        .unwrap_or_default();
    let href = crate::xdg::file_uri(path);
    let stamp_now = stamp(now);
    let exec = format!("'{app_binary} %u'");
    let cutoff = now - chrono::Duration::days(MAX_AGE_DAYS);
    let mut old: Option<Bookmark> = None;
    let mut items: Vec<Bookmark> = Vec::with_capacity(existing.len() + 1);
    for b in existing {
        if b.href == href {
            old = Some(b);
        } else if parse_stamp(&b.modified)
            .map(|m| m >= cutoff)
            .unwrap_or(true)
        {
            items.push(b);
        }
    }
    let mut entry = old.unwrap_or_else(|| Bookmark {
        href: href.clone(),
        added: stamp_now.clone(),
        modified: stamp_now.clone(),
        visited: stamp_now.clone(),
        mime: None,
        title: None,
        desc: None,
        private: false,
        groups: Vec::new(),
        applications: Vec::new(),
    });
    entry.modified = stamp_now.clone();
    entry.visited = stamp_now.clone();
    if let Some(m) = mime {
        entry.mime = Some(m.to_string());
    }
    match entry.applications.iter_mut().find(|a| a.name == app_name) {
        Some(a) => {
            a.count += 1;
            a.modified = stamp_now.clone();
            a.exec = exec;
        }
        None => entry.applications.push(Application {
            name: app_name.to_string(),
            exec,
            modified: stamp_now,
            count: 1,
        }),
    }
    items.push(entry);
    write_atomic(xbel, render(&items).as_bytes())
}

fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let dir = target.parent().expect("xbel path has a parent");
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        target.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        std::io::Write::write_all(&mut f, bytes)?;
    }
    std::fs::rename(&tmp, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    const GTK_SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0"
      xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks"
      xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info"
>
  <bookmark href="file:///home/me/old.pdf" added="2020-01-01T10:00:00.000000Z" modified="2020-01-02T10:00:00.000000Z" visited="2020-01-02T10:00:00.000000Z">
    <info>
      <metadata owner="http://freedesktop.org">
        <mime:mime-type type="application/pdf"/>
        <bookmark:applications>
          <bookmark:application name="Zathura" exec="&apos;zathura %u&apos;" modified="2020-01-02T10:00:00.000000Z" count="2"/>
        </bookmark:applications>
      </metadata>
    </info>
  </bookmark>
  <bookmark href="file:///home/me/a%20b.png" added="2026-11-18T10:00:00.000000Z" modified="2026-11-18T10:00:00.000000Z" visited="2026-11-18T10:00:00.000000Z">
    <title>a b</title>
    <info>
      <metadata owner="http://freedesktop.org">
        <mime:mime-type type="image/png"/>
        <bookmark:groups>
          <bookmark:group>Graphics</bookmark:group>
        </bookmark:groups>
        <bookmark:private/>
        <bookmark:applications>
          <bookmark:application name="imv" exec="&apos;imv %u&apos;" modified="2026-11-18T10:00:00.000000Z" count="1"/>
        </bookmark:applications>
      </metadata>
    </info>
  </bookmark>
</xbel>
"#;

    #[test]
    fn parses_gtk_output_and_round_trips() {
        let items = parse(GTK_SAMPLE);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].mime.as_deref(), Some("application/pdf"));
        assert_eq!(items[0].applications[0].exec, "'zathura %u'");
        assert_eq!(items[0].applications[0].count, 2);
        assert_eq!(items[1].title.as_deref(), Some("a b"));
        assert_eq!(items[1].groups, vec!["Graphics"]);
        assert!(items[1].private);
        assert_eq!(parse(&render(&items)), items);
        assert!(parse("garbage").is_empty());
    }

    #[test]
    fn add_bumps_prunes_and_writes_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let xbel = dir.path().join("share").join("recently-used.xbel");
        std::fs::create_dir_all(xbel.parent().unwrap()).unwrap();
        std::fs::write(&xbel, GTK_SAMPLE).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 11, 19, 15, 0, 0).unwrap();

        add(
            &xbel,
            Path::new("/home/me/new file.mkv"),
            Some("video/x-matroska"),
            "ewe Player",
            "ewe-player",
            now,
        )
        .unwrap();
        let items = parse(&std::fs::read_to_string(&xbel).unwrap());
        // the 2020 entry is older than 30 days: gone; the png stays; the new one is last
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].href, "file:///home/me/a%20b.png");
        let n = &items[1];
        assert_eq!(n.href, "file:///home/me/new%20file.mkv");
        assert_eq!(n.added, "2026-11-19T15:00:00.000000Z");
        assert_eq!(n.mime.as_deref(), Some("video/x-matroska"));
        assert_eq!(n.applications.len(), 1);
        assert_eq!(n.applications[0].name, "ewe Player");
        assert_eq!(n.applications[0].exec, "'ewe-player %u'");

        // opening the png again bumps it, keeps imv and adds us
        let later = now + chrono::Duration::minutes(5);
        add(
            &xbel,
            Path::new("/home/me/a b.png"),
            None,
            "ewe Viewer",
            "ewe-viewer",
            later,
        )
        .unwrap();
        let items = parse(&std::fs::read_to_string(&xbel).unwrap());
        assert_eq!(items.len(), 2);
        let p = &items[1];
        assert_eq!(p.href, "file:///home/me/a%20b.png");
        assert_eq!(p.added, "2026-11-18T10:00:00.000000Z");
        assert_eq!(p.modified, "2026-11-19T15:05:00.000000Z");
        assert_eq!(p.mime.as_deref(), Some("image/png"));
        assert_eq!(p.title.as_deref(), Some("a b"));
        assert_eq!(p.applications.len(), 2);
        assert_eq!(p.applications[1].name, "ewe Viewer");
        // a third open by the same app counts up
        add(
            &xbel,
            Path::new("/home/me/a b.png"),
            None,
            "ewe Viewer",
            "ewe-viewer",
            later,
        )
        .unwrap();
        let items = parse(&std::fs::read_to_string(&xbel).unwrap());
        assert_eq!(items[1].applications[1].count, 2);

        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&xbel).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            std::fs::read_dir(xbel.parent().unwrap()).unwrap().count() == 1,
            "no temp left"
        );

        // a missing file is created
        let fresh = dir.path().join("fresh").join("recently-used.xbel");
        add(
            &fresh,
            Path::new("/x/y.txt"),
            Some("text/plain"),
            "ewe Viewer",
            "ewe-viewer",
            now,
        )
        .unwrap();
        assert_eq!(parse(&std::fs::read_to_string(&fresh).unwrap()).len(), 1);
    }
}
