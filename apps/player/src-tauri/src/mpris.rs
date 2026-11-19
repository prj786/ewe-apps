//! `org.mpris.MediaPlayer2.ewe-player` on the session bus. The webview owns playback; it
//! pushes its state here (`mpris_update`) and every method call from the bus (the dock's
//! now-playing, media keys, playerctl) goes back to it as an `mpris-command` event.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use mpris_server::zbus::{self, fdo};
use mpris_server::{
    LoopStatus, Metadata, PlaybackRate, PlaybackStatus, PlayerInterface, Property, RootInterface,
    Server, Signal, Time, TrackId, Volume,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub const BUS_SUFFIX: &str = "ewe-player";

/// What the webview tells us (all fields optional: only what changed).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MprisUpdate {
    /// "playing" | "paused" | "stopped"
    pub status: Option<String>,
    /// "off" | "all" | "one"
    pub repeat: Option<String>,
    pub shuffle: Option<bool>,
    pub rate: Option<f64>,
    pub volume: Option<f64>,
    /// seconds
    pub position: Option<f64>,
    /// a seek happened (emit Seeked)
    pub seeked: Option<bool>,
    pub can_next: Option<bool>,
    pub can_previous: Option<bool>,
    pub metadata: Option<TrackMeta>,
    pub fullscreen: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackMeta {
    /// a stable id for the item (its index + path hash is fine)
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// seconds
    pub length: Option<f64>,
    /// file path or URL
    pub url: Option<String>,
    /// a `file://` URL to the art (the webview asks `cover_art_file` for it)
    pub art_url: Option<String>,
    pub track_number: Option<i32>,
}

/// What goes back to the webview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MprisCommand {
    pub action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

struct Inner {
    status: PlaybackStatus,
    loop_status: LoopStatus,
    shuffle: bool,
    rate: f64,
    volume: f64,
    position: f64,
    position_at: Instant,
    can_next: bool,
    can_previous: bool,
    meta: TrackMeta,
    fullscreen: bool,
}

pub struct Player {
    app: AppHandle,
    inner: Mutex<Inner>,
}

impl Player {
    fn send(&self, action: &'static str, value: Option<serde_json::Value>) {
        let _ = self
            .app
            .emit("mpris-command", MprisCommand { action, value });
    }

    fn position_now(&self) -> f64 {
        let i = self.inner.lock().unwrap();
        if i.status == PlaybackStatus::Playing {
            i.position + i.position_at.elapsed().as_secs_f64() * i.rate
        } else {
            i.position
        }
    }
}

fn track_id(id: &str) -> TrackId {
    // object paths allow [A-Za-z0-9_] only
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let path = format!(
        "/org/ewe/player/track/{}",
        if safe.is_empty() { "none" } else { &safe }
    );
    TrackId::try_from(path).unwrap_or_else(|_| TrackId::NO_TRACK)
}

fn metadata_of(meta: &TrackMeta) -> Metadata {
    if meta.id.is_empty() {
        return Metadata::new();
    }
    let mut b = Metadata::builder().trackid(track_id(&meta.id));
    if !meta.title.is_empty() {
        b = b.title(meta.title.clone());
    }
    if let Some(a) = &meta.artist
        && !a.is_empty()
    {
        b = b.artist([a.clone()]);
    }
    if let Some(a) = &meta.album
        && !a.is_empty()
    {
        b = b.album(a.clone());
    }
    if let Some(len) = meta.length.filter(|l| l.is_finite() && *l > 0.0) {
        b = b.length(Time::from_micros((len * 1_000_000.0) as i64));
    }
    if let Some(url) = &meta.url {
        let uri = if url.contains("://") {
            url.clone()
        } else {
            ewe_app_core::xdg::file_uri(std::path::Path::new(url))
        };
        b = b.url(uri);
    }
    if let Some(art) = &meta.art_url {
        b = b.art_url(art.clone());
    }
    if let Some(n) = meta.track_number {
        b = b.track_number(n);
    }
    b.build()
}

impl RootInterface for Player {
    async fn raise(&self) -> fdo::Result<()> {
        if let Some(win) = self.app.get_webview_window("main") {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
        Ok(())
    }
    async fn quit(&self) -> fdo::Result<()> {
        self.app.exit(0);
        Ok(())
    }
    async fn can_quit(&self) -> fdo::Result<bool> {
        Ok(true)
    }
    async fn fullscreen(&self) -> fdo::Result<bool> {
        Ok(self.inner.lock().unwrap().fullscreen)
    }
    async fn set_fullscreen(&self, fullscreen: bool) -> zbus::Result<()> {
        self.send("fullscreen", Some(fullscreen.into()));
        Ok(())
    }
    async fn can_set_fullscreen(&self) -> fdo::Result<bool> {
        Ok(true)
    }
    async fn can_raise(&self) -> fdo::Result<bool> {
        Ok(true)
    }
    async fn has_track_list(&self) -> fdo::Result<bool> {
        Ok(false)
    }
    async fn identity(&self) -> fdo::Result<String> {
        Ok("ewe Player".into())
    }
    async fn desktop_entry(&self) -> fdo::Result<String> {
        Ok("ewe-player".into())
    }
    async fn supported_uri_schemes(&self) -> fdo::Result<Vec<String>> {
        Ok(vec!["file".into(), "http".into(), "https".into()])
    }
    async fn supported_mime_types(&self) -> fdo::Result<Vec<String>> {
        Ok(vec![
            "video/mp4".into(),
            "video/x-matroska".into(),
            "video/webm".into(),
            "video/quicktime".into(),
            "video/x-msvideo".into(),
            "audio/mpeg".into(),
            "audio/flac".into(),
            "audio/ogg".into(),
            "audio/mp4".into(),
            "audio/x-wav".into(),
            "audio/x-m3u".into(),
        ])
    }
}

impl PlayerInterface for Player {
    async fn next(&self) -> fdo::Result<()> {
        self.send("next", None);
        Ok(())
    }
    async fn previous(&self) -> fdo::Result<()> {
        self.send("previous", None);
        Ok(())
    }
    async fn pause(&self) -> fdo::Result<()> {
        self.send("pause", None);
        Ok(())
    }
    async fn play_pause(&self) -> fdo::Result<()> {
        self.send("play-pause", None);
        Ok(())
    }
    async fn stop(&self) -> fdo::Result<()> {
        self.send("stop", None);
        Ok(())
    }
    async fn play(&self) -> fdo::Result<()> {
        self.send("play", None);
        Ok(())
    }
    async fn seek(&self, offset: Time) -> fdo::Result<()> {
        self.send(
            "seek",
            Some((offset.as_micros() as f64 / 1_000_000.0).into()),
        );
        Ok(())
    }
    async fn set_position(&self, track: TrackId, position: Time) -> fdo::Result<()> {
        let current = track_id(&self.inner.lock().unwrap().meta.id);
        if track == current {
            self.send(
                "set-position",
                Some((position.as_micros() as f64 / 1_000_000.0).into()),
            );
        }
        Ok(())
    }
    async fn open_uri(&self, uri: String) -> fdo::Result<()> {
        self.send("open-uri", Some(uri.into()));
        Ok(())
    }
    async fn playback_status(&self) -> fdo::Result<PlaybackStatus> {
        Ok(self.inner.lock().unwrap().status)
    }
    async fn loop_status(&self) -> fdo::Result<LoopStatus> {
        Ok(self.inner.lock().unwrap().loop_status)
    }
    async fn set_loop_status(&self, loop_status: LoopStatus) -> zbus::Result<()> {
        let value = match loop_status {
            LoopStatus::None => "off",
            LoopStatus::Track => "one",
            LoopStatus::Playlist => "all",
        };
        self.send("repeat", Some(value.into()));
        Ok(())
    }
    async fn rate(&self) -> fdo::Result<PlaybackRate> {
        Ok(self.inner.lock().unwrap().rate)
    }
    async fn set_rate(&self, rate: PlaybackRate) -> zbus::Result<()> {
        self.send("rate", Some(rate.into()));
        Ok(())
    }
    async fn shuffle(&self) -> fdo::Result<bool> {
        Ok(self.inner.lock().unwrap().shuffle)
    }
    async fn set_shuffle(&self, shuffle: bool) -> zbus::Result<()> {
        self.send("shuffle", Some(shuffle.into()));
        Ok(())
    }
    async fn metadata(&self) -> fdo::Result<Metadata> {
        Ok(metadata_of(&self.inner.lock().unwrap().meta))
    }
    async fn volume(&self) -> fdo::Result<Volume> {
        Ok(self.inner.lock().unwrap().volume)
    }
    async fn set_volume(&self, volume: Volume) -> zbus::Result<()> {
        self.send("volume", Some(volume.clamp(0.0, 1.5).into()));
        Ok(())
    }
    async fn position(&self) -> fdo::Result<Time> {
        Ok(Time::from_micros(
            (self.position_now().max(0.0) * 1_000_000.0) as i64,
        ))
    }
    async fn minimum_rate(&self) -> fdo::Result<PlaybackRate> {
        Ok(0.25)
    }
    async fn maximum_rate(&self) -> fdo::Result<PlaybackRate> {
        Ok(3.0)
    }
    async fn can_go_next(&self) -> fdo::Result<bool> {
        Ok(self.inner.lock().unwrap().can_next)
    }
    async fn can_go_previous(&self) -> fdo::Result<bool> {
        Ok(self.inner.lock().unwrap().can_previous)
    }
    async fn can_play(&self) -> fdo::Result<bool> {
        Ok(true)
    }
    async fn can_pause(&self) -> fdo::Result<bool> {
        Ok(true)
    }
    async fn can_seek(&self) -> fdo::Result<bool> {
        Ok(true)
    }
    async fn can_control(&self) -> fdo::Result<bool> {
        Ok(true)
    }
}

/// The running server, or `None` until the bus answered (or when there is no bus).
#[derive(Clone, Default)]
pub struct Mpris {
    server: Arc<OnceLock<Server<Player>>>,
    pending: Arc<Mutex<Vec<MprisUpdate>>>,
}

impl Mpris {
    /// Start on Tauri's runtime; the name appears on the bus a moment later.
    pub fn start(app: AppHandle) -> Mpris {
        let mpris = Mpris::default();
        let slot = mpris.server.clone();
        let pending = mpris.pending.clone();
        tauri::async_runtime::spawn(async move {
            let player = Player {
                app: app.clone(),
                inner: Mutex::new(Inner {
                    status: PlaybackStatus::Stopped,
                    loop_status: LoopStatus::None,
                    shuffle: false,
                    rate: 1.0,
                    volume: 1.0,
                    position: 0.0,
                    position_at: Instant::now(),
                    can_next: false,
                    can_previous: false,
                    meta: TrackMeta::default(),
                    fullscreen: false,
                }),
            };
            match Server::new(BUS_SUFFIX, player).await {
                Ok(server) => {
                    let _ = slot.set(server);
                    let queued: Vec<MprisUpdate> = std::mem::take(&mut *pending.lock().unwrap());
                    if let Some(server) = slot.get() {
                        for u in queued {
                            apply(server, u).await;
                        }
                    }
                }
                Err(e) => eprintln!("ewe-player: no MPRIS (session bus): {e}"),
            }
        });
        mpris
    }

    pub fn update(&self, update: MprisUpdate) {
        if self.server.get().is_none() {
            self.pending.lock().unwrap().push(update);
            return;
        }
        let slot = self.server.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(server) = slot.get() {
                apply(server, update).await;
            }
        });
    }
}

async fn apply(server: &Server<Player>, u: MprisUpdate) {
    let mut changed: Vec<Property> = Vec::new();
    let mut seeked: Option<Time> = None;
    {
        let imp = server.imp();
        let mut i = imp.inner.lock().unwrap();
        if let Some(s) = &u.status {
            let status = match s.as_str() {
                "playing" => PlaybackStatus::Playing,
                "paused" => PlaybackStatus::Paused,
                _ => PlaybackStatus::Stopped,
            };
            if status != i.status {
                // freeze or restart the position clock
                let now = imp_position(&i);
                i.position = now;
                i.position_at = Instant::now();
                i.status = status;
                changed.push(Property::PlaybackStatus(status));
            }
        }
        if let Some(r) = &u.repeat {
            let ls = match r.as_str() {
                "one" => LoopStatus::Track,
                "all" => LoopStatus::Playlist,
                _ => LoopStatus::None,
            };
            if ls != i.loop_status {
                i.loop_status = ls;
                changed.push(Property::LoopStatus(ls));
            }
        }
        if let Some(s) = u.shuffle
            && s != i.shuffle
        {
            i.shuffle = s;
            changed.push(Property::Shuffle(s));
        }
        if let Some(r) = u.rate
            && (r - i.rate).abs() > 1e-6
        {
            i.position = imp_position(&i);
            i.position_at = Instant::now();
            i.rate = r;
            changed.push(Property::Rate(r));
        }
        if let Some(v) = u.volume
            && (v - i.volume).abs() > 1e-6
        {
            i.volume = v;
            changed.push(Property::Volume(v));
        }
        if let Some(p) = u.position {
            i.position = p;
            i.position_at = Instant::now();
            if u.seeked == Some(true) {
                seeked = Some(Time::from_micros((p * 1_000_000.0) as i64));
            }
        }
        if let Some(c) = u.can_next
            && c != i.can_next
        {
            i.can_next = c;
            changed.push(Property::CanGoNext(c));
        }
        if let Some(c) = u.can_previous
            && c != i.can_previous
        {
            i.can_previous = c;
            changed.push(Property::CanGoPrevious(c));
        }
        if let Some(m) = u.metadata
            && m != i.meta
        {
            i.meta = m;
            changed.push(Property::Metadata(metadata_of(&i.meta)));
        }
        if let Some(f) = u.fullscreen
            && f != i.fullscreen
        {
            i.fullscreen = f;
            changed.push(Property::Fullscreen(f));
        }
    }
    if !changed.is_empty() {
        let _ = server.properties_changed(changed).await;
    }
    if let Some(pos) = seeked {
        let _ = server.emit(Signal::Seeked { position: pos }).await;
    }
}

fn imp_position(i: &Inner) -> f64 {
    if i.status == PlaybackStatus::Playing {
        i.position + i.position_at.elapsed().as_secs_f64() * i.rate
    } else {
        i.position
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_ids_are_object_paths_and_metadata_carries_the_essentials() {
        let id = track_id("3:/home/me/a b.flac");
        assert_eq!(id.as_str(), "/org/ewe/player/track/3__home_me_a_b_flac");
        assert_eq!(track_id("").as_str(), "/org/ewe/player/track/none");
        let meta = metadata_of(&TrackMeta {
            id: "x".into(),
            title: "Song".into(),
            artist: Some("Band".into()),
            album: Some("Album".into()),
            length: Some(12.5),
            url: Some("/m/song.flac".into()),
            art_url: Some("file:///c/art.jpg".into()),
            track_number: Some(2),
        });
        assert_eq!(meta.title(), Some("Song"));
        assert_eq!(meta.artist(), Some(vec!["Band".to_string()]));
        assert_eq!(meta.length(), Some(Time::from_micros(12_500_000)));
        assert_eq!(
            meta.url().map(|u| u.to_string()),
            Some("file:///m/song.flac".into())
        );
        assert_eq!(
            meta.art_url().map(|u| u.to_string()),
            Some("file:///c/art.jpg".into())
        );
        assert_eq!(meta.track_number(), Some(2));
        assert!(metadata_of(&TrackMeta::default()).title().is_none());
    }
}
