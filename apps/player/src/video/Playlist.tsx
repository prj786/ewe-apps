import { For, Show, createSignal, type JSX } from 'solid-js'
import { formatClock, itemTitle, moveItem, stemOf, type MediaItem } from '@ewe/shared'
import { Button, Icon, IconButton } from '@ewe/ui'

export interface PlaylistProps {
  queue: MediaItem[]
  index: number
  /** media next to the current file, for adding */
  folder: MediaItem[]
  onPlay(index: number): void
  onQueue(queue: MediaItem[], index: number): void
  onAddFolder(): void
  onAddFiles(): void
  onClose(): void
}

/** The queue (drag to reorder) and the current file's folder siblings. */
export function Playlist(props: PlaylistProps): JSX.Element {
  const [dragFrom, setDragFrom] = createSignal<number | null>(null)
  const [dropAt, setDropAt] = createSignal<number | null>(null)

  const inQueue = (item: MediaItem) => props.queue.some((q) => q.path === item.path)

  const remove = (i: number) => {
    const next = props.queue.filter((_, k) => k !== i)
    let index = props.index
    if (i < index) index -= 1
    else if (i === index) index = Math.min(index, next.length - 1)
    props.onQueue(next, Math.max(0, index))
  }

  const finishDrop = (to: number) => {
    const from = dragFrom()
    setDragFrom(null)
    setDropAt(null)
    if (from === null) return
    const moved = moveItem(props.queue, from, to)
    if (moved === props.queue) return
    const current = props.queue[props.index]
    const index = current === undefined ? 0 : Math.max(0, moved.indexOf(current))
    props.onQueue(moved, index)
  }

  const addSibling = (item: MediaItem) => {
    if (inQueue(item)) {
      props.onPlay(props.queue.findIndex((q) => q.path === item.path))
      return
    }
    const next = [...props.queue, item]
    props.onQueue(next, props.index)
    props.onPlay(next.length - 1)
  }

  return (
    <aside class="pl" aria-label="Playlist">
      <header class="pl-head">
        <Icon name="list-music" />
        <h2>Playlist</h2>
        <span class="pl-count">{props.queue.length}</span>
        <IconButton icon="x" label="Close playlist" size="sm" onClick={() => props.onClose()} />
      </header>
      <div class="pl-body">
        <Show
          when={props.queue.length > 0}
          fallback={<p class="pl-empty">Nothing queued. Add files or a folder.</p>}
        >
          <ol
            class="pl-list"
            onDragOver={(e) => {
              if (dragFrom() === null) return
              e.preventDefault()
              const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.pl-row')]
              let at = rows.length
              for (let i = 0; i < rows.length; i++) {
                const r = rows[i]?.getBoundingClientRect()
                if (r !== undefined && e.clientY < r.top + r.height / 2) {
                  at = i
                  break
                }
              }
              setDropAt(at)
            }}
            onDrop={(e) => {
              e.preventDefault()
              finishDrop(dropAt() ?? props.queue.length)
            }}
          >
            <For each={props.queue}>
              {(item, i) => (
                <li
                  class="pl-row"
                  classList={{
                    current: i() === props.index,
                    'drop-before': dropAt() === i(),
                    dragging: dragFrom() === i(),
                  }}
                  draggable={true}
                  onDragStart={(e) => {
                    setDragFrom(i())
                    e.dataTransfer?.setData('text/plain', item.path)
                  }}
                  onDragEnd={() => {
                    setDragFrom(null)
                    setDropAt(null)
                  }}
                  onDblClick={() => props.onPlay(i())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') props.onPlay(i())
                    else if (e.key === 'Delete') remove(i())
                  }}
                  tabindex="0"
                >
                  <span class="pl-grip" aria-hidden="true">
                    <Icon name="grip-vertical" size={14} />
                  </span>
                  <span class="pl-num">
                    <Show when={i() === props.index} fallback={i() + 1}>
                      <Icon name="play" size={12} />
                    </Show>
                  </span>
                  <button class="pl-name" title={item.path} onClick={() => props.onPlay(i())}>
                    <Show
                      when={item.thumbnail}
                      fallback={<Icon name={item.kind === 'audio' ? 'music' : 'film'} size={14} />}
                    >
                      {(src) => <img class="pl-thumb" src={src()} alt="" loading="lazy" />}
                    </Show>
                    <span dir="auto">{itemTitle(item)}</span>
                    <Show when={item.duration}>
                      {(d) => <span class="pl-dur">{formatClock(d())}</span>}
                    </Show>
                  </button>
                  <IconButton
                    icon="x"
                    label="Remove from playlist"
                    size="sm"
                    quiet
                    class="pl-remove"
                    onClick={() => remove(i())}
                  />
                </li>
              )}
            </For>
            <li
              class="pl-row pl-tail"
              classList={{ 'drop-before': dropAt() === props.queue.length }}
              aria-hidden="true"
            />
          </ol>
        </Show>
        <div class="pl-actions">
          <Button small icon="plus" onClick={() => props.onAddFiles()}>
            Add files…
          </Button>
          <Show when={props.folder.some((f) => !inQueue(f))}>
            <Button small kind="ghost" icon="folder-plus" onClick={() => props.onAddFolder()}>
              Add the whole folder
            </Button>
          </Show>
        </div>
        <Show when={props.folder.length > 0}>
          <h3 class="pl-sub">In this folder</h3>
          <ul class="pl-list pl-folder">
            <For each={props.folder}>
              {(item) => (
                <li class="pl-row" classList={{ queued: inQueue(item) }}>
                  <span class="pl-num">
                    <Icon name={inQueue(item) ? 'check' : 'plus'} size={12} />
                  </span>
                  <button class="pl-name" title={item.path} onClick={() => addSibling(item)}>
                    <Icon name={item.kind === 'audio' ? 'music' : 'film'} size={14} />
                    <span dir="auto">{stemOf(item.name)}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </aside>
  )
}
