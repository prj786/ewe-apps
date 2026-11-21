import { For, Show, createSignal, onMount, type JSX } from 'solid-js'
import {
  formatClock,
  mediaKind,
  stemOf,
  thumbUrl,
  timeAgo,
  type MediaServer,
  type SavedPosition,
} from '@ewe/shared'
import { Button, EmptyState, Icon } from '@ewe/ui'
import { recentMedia, type RecentItem } from '../bridge'

export interface StartScreenProps {
  server: MediaServer
  positions: Record<string, SavedPosition>
  onOpen(path: string): void
  onOpenFiles(): void
  onOpenFolder(): void
  onOpenUrl(): void
  onMusic(): void
  dropping: boolean
}

/** The start screen: open something, or pick up where you left off. */
export function StartScreen(props: StartScreenProps): JSX.Element {
  const [recents, setRecents] = createSignal<RecentItem[]>([])

  onMount(() => {
    void recentMedia().then(setRecents)
  })

  const videos = () => recents().filter((r) => mediaKind(r.name) === 'video')
  const songs = () => recents().filter((r) => mediaKind(r.name) === 'audio')

  const Thumb = (p: { item: RecentItem }): JSX.Element => {
    const [failed, setFailed] = createSignal(false)
    const saved = () => props.positions[p.item.path]
    return (
      <button class="st-tile" onClick={() => props.onOpen(p.item.path)} title={p.item.path}>
        <span class="st-thumb">
          <Icon name="film" size={24} />
          <Show when={!failed()}>
            <img
              src={thumbUrl(props.server, p.item.path, 256)}
              alt=""
              loading="lazy"
              onError={() => setFailed(true)}
            />
          </Show>
          <Show when={saved()}>
            {(s) => (
              <span
                class="st-progress"
                style={{ '--p': `${(s().position / Math.max(1, s().duration)) * 100}%` }}
              />
            )}
          </Show>
        </span>
        <span class="st-name" dir="auto">
          {stemOf(p.item.name)}
        </span>
        <span class="st-sub">
          <Show when={saved()} fallback={timeAgo(Date.parse(p.item.modified) || Date.now())}>
            {(s) => `Continue at ${formatClock(s().position)}`}
          </Show>
        </span>
      </button>
    )
  }

  return (
    <div class="st" classList={{ dropping: props.dropping }}>
      <div class="st-hero">
        <EmptyState icon="play" title="ewe Player" heading="h1">
          Open a video or a song, or drop one here.
        </EmptyState>
        <div class="st-actions">
          <Button kind="primary" icon="folder-open" onClick={() => props.onOpenFiles()}>
            Open files…
          </Button>
          <Button icon="folder" onClick={() => props.onOpenFolder()}>
            Open folder…
          </Button>
          <Button icon="link" onClick={() => props.onOpenUrl()}>
            Open URL…
          </Button>
          <Button kind="ghost" icon="music" onClick={() => props.onMusic()}>
            Music
          </Button>
        </div>
      </div>
      <Show when={videos().length > 0}>
        <section class="st-section">
          <h2>Recent videos</h2>
          <div class="st-grid">
            <For each={videos()}>{(item) => <Thumb item={item} />}</For>
          </div>
        </section>
      </Show>
      <Show when={songs().length > 0}>
        <section class="st-section">
          <h2>Recent songs</h2>
          <ul class="st-songs">
            <For each={songs().slice(0, 8)}>
              {(item) => (
                <li>
                  <button class="st-song" onClick={() => props.onOpen(item.path)} title={item.path}>
                    <Icon name="music" size={14} />
                    <span dir="auto">{stemOf(item.name)}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={props.dropping}>
        <div class="drop-hint">
          <Icon name="download" size={32} />
          <span>Drop to play</span>
        </div>
      </Show>
    </div>
  )
}
