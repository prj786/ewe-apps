// The places panel: Home and folders, cloud, synced, bookmarks, devices, other.

import { For, Show, type JSX } from 'solid-js'
import {
  TRASH_PATH,
  syncLabel,
  type Device,
  type FsPlace,
  type FsPlaceGroup,
  type FsPlaceIcon,
  type FsPlaceSync,
  type FsSyncState,
  type Point,
} from '@ewe/shared'
import { Icon, IconButton, type IconName } from '@ewe/ui'

export const PLACE_ICON: Record<FsPlaceIcon, IconName> = {
  house: 'house',
  folder: 'folder',
  download: 'download',
  file: 'file-text',
  image: 'image',
  music: 'music',
  video: 'video',
  code: 'code',
  cloud: 'cloud',
  drive: 'hard-drive',
  'hard-drive': 'hard-drive',
  server: 'server',
  'trash-2': 'trash-2',
  monitor: 'monitor',
  'app-window': 'app-window',
}

export const SYNC_ICON: Record<FsSyncState, IconName> = {
  synced: 'cloud',
  syncing: 'refresh-cw',
  pending: 'cloud',
  paused: 'pause',
  error: 'circle-alert',
  conflict: 'triangle-alert',
  offline: 'cloud',
}

const GROUPS: { id: FsPlaceGroup; label: string }[] = [
  { id: 'places', label: 'Places' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'synced', label: 'Synced' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'devices', label: 'Devices' },
  { id: 'other', label: 'Other' },
]

export function syncTitle(path: string, sync: FsPlaceSync): string {
  const parts = [path, syncLabel(sync)]
  if (sync.engine === 'nextcloud-app') parts.push('Synced by the Nextcloud app')
  if (sync.state === 'error' && sync.error !== '') parts.push(sync.error)
  if (sync.lastSync !== null)
    parts.push(
      `Last synced ${new Date(sync.lastSync).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`,
    )
  return parts.join(' · ')
}

export interface PlacesProps {
  places: FsPlace[]
  devices: Device[]
  activePath: string
  dropTarget: string | null
  trashCount: number | null
  /** apps are installing: what Applications says beside its name ("43%", "…") */
  installing?: string | null | undefined
  onOpen(place: FsPlace): void
  onOpenPath(path: string, newTab: boolean): void
  onDevice(device: Device, action: 'mount' | 'unmount' | 'eject' | 'open'): void
  onMenu(target: { place?: FsPlace; device?: Device }, at: Point): void
  onConnect(): void
  dropHandlers(dir: () => string): Record<string, unknown>
  /** compact windows: the panel floats over the pane (closes on a place or a click outside) */
  drawer?: boolean | undefined
}

export function Places(props: PlacesProps): JSX.Element {
  const inside = (path: string) =>
    props.activePath === path || props.activePath.startsWith(path === '/' ? '/' : `${path}/`)
  const activeId = () => {
    let best: FsPlace | null = null
    for (const p of props.places) {
      if (p.path === TRASH_PATH ? props.activePath === TRASH_PATH : inside(p.path))
        if (best === null || p.path.length > best.path.length) best = p
    }
    return best?.id ?? null
  }
  // GVFS mounts and /run/media folders already appear as places; devices add the rest
  const extraDevices = () =>
    props.devices.filter((d) => d.path === null || !props.places.some((p) => p.path === d.path))
  return (
    <aside class="fm-places" classList={{ drawer: props.drawer ?? false }} aria-label="Places">
      <For each={GROUPS}>
        {(group) => (
          <Show
            when={
              props.places.some((p) => p.group === group.id) ||
              (group.id === 'devices' && extraDevices().length > 0)
            }
          >
            <div class="fm-group">{group.label}</div>
            <For each={props.places.filter((p) => p.group === group.id)}>
              {(place) => (
                <button
                  class="fm-place"
                  classList={{
                    active: activeId() === place.id,
                    [place.state]: true,
                    drop: props.dropTarget === place.path,
                  }}
                  data-place={place.id}
                  title={
                    place.state === 'setup'
                      ? 'Sign in to your ewe account in ewe Sync'
                      : place.state === 'offline' && place.mount !== undefined
                        ? `Connect ${place.label}`
                        : place.sync === undefined
                          ? place.path
                          : syncTitle(place.path, place.sync)
                  }
                  onClick={() => props.onOpen(place)}
                  onAuxClick={(e) => {
                    if (e.button !== 1 || place.state !== 'ready') return
                    e.preventDefault()
                    props.onOpenPath(place.path, true)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    props.onMenu({ place }, { x: e.clientX, y: e.clientY })
                  }}
                  {...(place.path === TRASH_PATH ? {} : props.dropHandlers(() => place.path))}
                >
                  <Icon name={PLACE_ICON[place.icon]} />
                  <span class="fm-place-label" dir="auto">
                    {place.label}
                  </span>
                  <Show when={place.state === 'offline' && place.mount !== undefined}>
                    <span class="fm-place-state">Connect</span>
                  </Show>
                  <Show when={place.state === 'ready' ? place.sync : undefined}>
                    {(sync) => (
                      <span
                        class="fm-place-sync"
                        classList={{ [sync().state]: true }}
                        aria-label={syncLabel(sync())}
                      >
                        <Icon name={SYNC_ICON[sync().state]} size={12} />
                      </span>
                    )}
                  </Show>
                  <Show when={place.state === 'setup'}>
                    <span class="fm-place-state">Set up</span>
                  </Show>
                  <Show when={place.id === 'applications' ? props.installing : null}>
                    {(text) => (
                      <span class="fm-place-state installing" aria-label="Installing apps">
                        {text()}
                      </span>
                    )}
                  </Show>
                  <Show
                    when={
                      place.path === TRASH_PATH && props.trashCount !== null && props.trashCount > 0
                    }
                  >
                    <span class="fm-place-state">{props.trashCount}</span>
                  </Show>
                </button>
              )}
            </For>
            <Show when={group.id === 'devices'}>
              <For each={extraDevices()}>
                {(d) => (
                  <button
                    class="fm-place fm-device"
                    classList={{
                      active: d.path !== null && inside(d.path),
                      offline: !d.mounted,
                      drop: d.path !== null && props.dropTarget === d.path,
                    }}
                    title={d.uri ?? d.label}
                    onClick={() => props.onDevice(d, d.mounted ? 'open' : 'mount')}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      props.onMenu({ device: d }, { x: e.clientX, y: e.clientY })
                    }}
                    {...(d.path === null ? {} : props.dropHandlers(() => d.path ?? ''))}
                  >
                    <Icon name={d.icon} />
                    <span class="fm-place-label" dir="auto">
                      {d.label}
                    </span>
                    <Show when={!d.mounted}>
                      <span class="fm-place-state">Connect</span>
                    </Show>
                    <Show when={d.mounted && (d.canEject || d.canUnmount)}>
                      <span
                        class="fm-place-eject"
                        role="button"
                        aria-label={d.canEject ? 'Eject' : 'Unmount'}
                        title={d.canEject ? 'Eject' : 'Unmount'}
                        onClick={(e) => {
                          e.stopPropagation()
                          props.onDevice(d, d.canEject ? 'eject' : 'unmount')
                        }}
                      >
                        <Icon name="eject" size={12} />
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        )}
      </For>
      <div class="fm-places-foot">
        <IconButton
          icon="plug"
          label="Connect to a server…"
          size="sm"
          onClick={() => props.onConnect()}
        />
      </div>
    </aside>
  )
}
