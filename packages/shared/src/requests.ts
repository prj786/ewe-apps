// Request and response shapes the three apps share with ewe-app-core (Rust).
// Field names are the serde names: snake_case on the wire is avoided on
// purpose — every struct in the core derives `serde(rename_all = "camelCase")`.

/** What the process was started with (and what a second launch forwards). */
export interface Launch {
  /** absolute paths, file:// URLs already turned into paths */
  paths: string[]
  /** raw `--flags`, in order, for the app to interpret */
  flags: string[]
  cwd: string
}

/** One application from GIO that can open a content type. */
export interface AppInfo {
  /** the desktop id, e.g. `org.gnome.Loupe.desktop` */
  id: string
  name: string
  /** an icon name from the theme, or null */
  icon: string | null
  /** the Exec line, for display only */
  exec: string
  default: boolean
}

export interface MimeInfo {
  path: string
  /** the content type GIO guessed, e.g. `video/mp4` */
  type: string
  /** a plain-words description, e.g. `MP4 video` */
  description: string
  /** the guess came from the name only, not the content */
  uncertain: boolean
}

export interface ThumbRequest {
  path: string
  size: 128 | 256 | 512
}

/** The core's answer to `app_version`: every CLI surface prints JSON (rule 5). */
export interface AppVersion {
  name: string
  version: string
}

export type ThemeEvent = 'theme-changed'
export type LaunchEvent = 'launch'
