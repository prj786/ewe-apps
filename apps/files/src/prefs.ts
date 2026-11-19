// What the app remembers: view, sort, hidden, zoom (per app, and per folder when
// the folder was changed by hand), the places panel and preview pane, in localStorage.

import type { SortKey } from '@ewe/shared'

export type View = 'grid' | 'list'
export const ZOOMS = [64, 80, 96, 112, 136, 168] as const
export type Zoom = (typeof ZOOMS)[number]

export interface ViewPrefs {
  view: View
  sort: SortKey
  desc: boolean
  hidden: boolean
  zoom: Zoom
}

export interface AppPrefs extends ViewPrefs {
  places: boolean
  preview: boolean
  /** folders whose view was set by hand */
  folders: Record<string, Partial<ViewPrefs>>
}

const KEY = 'ewe.files.prefs'
const MAX_FOLDERS = 400

export const DEFAULT_PREFS: AppPrefs = {
  view: 'grid',
  sort: 'name',
  desc: false,
  hidden: false,
  zoom: 96,
  places: true,
  preview: false,
  folders: {},
}

function isSort(v: unknown): v is SortKey {
  return v === 'name' || v === 'mtime' || v === 'size' || v === 'kind'
}

function isZoom(v: unknown): v is Zoom {
  return typeof v === 'number' && (ZOOMS as readonly number[]).includes(v)
}

function cleanView(raw: Record<string, unknown>, base: ViewPrefs): ViewPrefs {
  return {
    view: raw.view === 'list' ? 'list' : raw.view === 'grid' ? 'grid' : base.view,
    sort: isSort(raw.sort) ? raw.sort : base.sort,
    desc: typeof raw.desc === 'boolean' ? raw.desc : base.desc,
    hidden: typeof raw.hidden === 'boolean' ? raw.hidden : base.hidden,
    zoom: isZoom(raw.zoom) ? raw.zoom : base.zoom,
  }
}

export function loadPrefs(): AppPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof raw !== 'object' || raw === null) return DEFAULT_PREFS
    const r = raw as Record<string, unknown>
    const folders: Record<string, Partial<ViewPrefs>> = {}
    if (typeof r.folders === 'object' && r.folders !== null) {
      for (const [path, v] of Object.entries(r.folders as Record<string, unknown>)) {
        if (typeof v !== 'object' || v === null) continue
        const o = v as Record<string, unknown>
        const partial: Partial<ViewPrefs> = {}
        if (o.view === 'list' || o.view === 'grid') partial.view = o.view
        if (isSort(o.sort)) partial.sort = o.sort
        if (typeof o.desc === 'boolean') partial.desc = o.desc
        if (isZoom(o.zoom)) partial.zoom = o.zoom
        if (Object.keys(partial).length > 0) folders[path] = partial
      }
    }
    return {
      ...cleanView(r, DEFAULT_PREFS),
      places: r.places !== false,
      preview: r.preview === true,
      folders,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(prefs: AppPrefs): void {
  try {
    const entries = Object.entries(prefs.folders)
    const folders = Object.fromEntries(entries.slice(-MAX_FOLDERS))
    localStorage.setItem(KEY, JSON.stringify({ ...prefs, folders }))
  } catch {
    return
  }
}

/** The view for `path`: the folder's own choices over the app's. */
export function viewFor(prefs: AppPrefs, path: string): ViewPrefs {
  const own = prefs.folders[path]
  return {
    view: own?.view ?? prefs.view,
    sort: own?.sort ?? prefs.sort,
    desc: own?.desc ?? prefs.desc,
    hidden: prefs.hidden,
    zoom: own?.zoom ?? prefs.zoom,
  }
}
