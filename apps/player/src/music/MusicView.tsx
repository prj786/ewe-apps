import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import {
  compareTracks,
  coverUrl,
  decodeFailureMessage,
  formatDuration,
  groupAlbums,
  groupArtists,
  nextIndex,
  previousIndex,
  rawUrl,
  searchTracks,
  shuffled,
  stemOf,
  type Album,
  type Artist,
  type MediaServer,
  type RepeatMode,
  type Track,
} from '@ewe/shared'
import {
  Button,
  Icon,
  IconButton,
  Menu,
  Segmented,
  addRecent,
  toast,
  type IconName,
  type MenuEntry,
} from '@ewe/ui'
import { AudioEngine } from '../audio'
import { coverArtFile, launchWith, probeMedia, type Library, type Transport } from '../bridge'
import { publish } from '../mpris'
import type { MusicPrefs, MusicView as MainView } from '../store'
import './music.css'

type View =
  | { kind: MainView }
  | { kind: 'album'; key: string }
  | { kind: 'artist'; name: string }
  | { kind: 'now' }

export interface PlayRequest {
  tracks: Track[]
  start: Track | undefined
  /** none of these are in the library: show the now-playing page */
  external: boolean
  append: boolean
  nonce: number
}

export interface MusicViewProps {
  server: MediaServer
  library: Library | null
  onRescan(): void
  prefs: MusicPrefs
  onPrefs(patch: Partial<MusicPrefs>): void
  request: PlayRequest | null
  onTransport(transport: Transport | null): void
  onOpenFiles(): void
  onOpenPlaylist(path: string | null): void
  onSavePlaylist(tracks: Track[]): void
  /** screenshot hook: music-albums | music-album | music-songs | music-now | music-playing */
  scene: string | null
}

function hue(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360
  return h
}

function joinParts(parts: string[]): string {
  return parts.filter((x) => x !== '').join(' · ')
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function MusicView(props: MusicViewProps): JSX.Element {
  // eslint-disable-next-line solid/reactivity -- the saved view and index seed the signals once
  const [view, setView] = createSignal<View>({ kind: props.prefs.view })
  const [query, setQuery] = createSignal('')
  const [queue, setQueue] = createSignal<Track[]>([])
  // eslint-disable-next-line solid/reactivity
  const [index, setIndex] = createSignal(props.prefs.index)
  const [playing, setPlaying] = createSignal(false)
  const [time, setTime] = createSignal(0)
  const [duration, setDuration] = createSignal(0)
  const [error, setError] = createSignal<string | null>(null)
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null)
  let search: HTMLInputElement | undefined
  let restored = false
  let lastPublished = 0

  const volume = () => props.prefs.volume
  const shuffle = () => props.prefs.shuffle
  const repeat = () => props.prefs.repeat

  const tracks = createMemo(() => [...(props.library?.tracks ?? [])].sort(compareTracks))
  const albums = createMemo(() => groupAlbums(tracks()))
  const artists = createMemo(() => groupArtists(albums()))
  const found = createMemo(() => searchTracks(tracks(), query()))
  const current = () => queue()[index()]

  const engine = new AudioEngine({
    onPlay: () => {
      setPlaying(true)
      publish({ status: 'playing', position: engine.currentTime }, true)
      const t = current()
      if (t !== undefined) void addRecent(t.path).catch(() => undefined)
    },
    onPause: () => {
      setPlaying(false)
      publish({ status: 'paused', position: engine.currentTime }, true)
    },
    onTime: (t) => {
      setTime(t)
      const now = Date.now()
      if (now - lastPublished > 1000) {
        lastPublished = now
        publish({ position: t })
      }
    },
    onDuration: (d) => setDuration(d),
    onEnded: () => next(false),
    onError: (code) => {
      const t = current()
      setPlaying(false)
      publish({ status: 'stopped' }, true)
      if (t === undefined) return
      setError(`Cannot play ${t.title}`)
      void probeMedia(t.path)
        .catch(() => null)
        .then((streams) => {
          const msg = decodeFailureMessage(t.title, streams, code)
          setError(msg.detail)
          toast(`${msg.title}. ${msg.detail}`, { kind: 'danger', duration: 8000 })
        })
    },
  })

  const play = () => queueMicrotask(() => void engine.play().catch(() => undefined))

  const playList = (list: Track[], start: Track | undefined) => {
    if (list.length === 0) return
    const first = start ?? list[0]
    const q = shuffle() ? shuffled(list, first) : list
    setQueue(q)
    setIndex(Math.max(0, first === undefined ? 0 : q.indexOf(first)))
    setError(null)
    play()
  }

  const toggle = () => {
    if (current() === undefined) {
      playList(found(), undefined)
      return
    }
    if (engine.paused) play()
    else engine.pause()
  }

  const next = (manual: boolean) => {
    const i = nextIndex(index(), queue().length, repeat(), manual)
    if (i === null) {
      setPlaying(false)
      publish({ status: 'stopped' }, true)
      return
    }
    if (i === index()) {
      engine.currentTime = 0
      play()
      return
    }
    setIndex(i)
    play()
  }

  const previous = () => {
    if (engine.currentTime > 3) {
      engine.currentTime = 0
      return
    }
    const i = previousIndex(index(), queue().length)
    if (i === null) return
    setIndex(i)
    play()
  }

  const setShuffle = (enabled: boolean) => {
    props.onPrefs({ shuffle: enabled })
    const track = current()
    if (track === undefined) return
    const base = enabled ? shuffled(queue(), track) : [...queue()].sort(compareTracks)
    setQueue(base)
    setIndex(Math.max(0, base.indexOf(track)))
  }

  const cycleRepeat = () => {
    const r = repeat()
    props.onPrefs({ repeat: r === 'off' ? 'all' : r === 'all' ? 'one' : 'off' })
  }

  const transport: Transport = {
    toggle,
    play,
    pause: () => engine.pause(),
    stop: () => {
      engine.pause()
      engine.currentTime = 0
    },
    next: () => next(true),
    previous,
    seekBy: (s) => {
      engine.currentTime = engine.currentTime + s
      publish({ position: engine.currentTime, seeked: true }, true)
    },
    seekTo: (s) => {
      engine.currentTime = s
      publish({ position: engine.currentTime, seeked: true }, true)
    },
    volumeBy: (d) => props.onPrefs({ volume: Math.min(1, Math.max(0, volume() + d)) }),
    setVolume: (v) => props.onPrefs({ volume: Math.min(1, Math.max(0, v)) }),
    setRate: (r) => {
      engine.playbackRate = r
    },
    setRepeat: (mode: RepeatMode) => props.onPrefs({ repeat: mode }),
    setShuffle,
    toggleMute: () => props.onPrefs({ volume: volume() === 0 ? 0.8 : 0 }),
  }

  const url = (route: 'raw' | 'cover', path: string) =>
    route === 'raw' ? rawUrl(props.server, path) : coverUrl(props.server, path)

  const openFolder = () => {
    const root = props.library?.roots[0]
    if (root !== undefined) void launchWith(null, [root]).catch(() => undefined)
  }

  onMount(() => {
    props.onTransport(transport)
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.tagName === 'INPUT') return
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') search?.focus()
        else return
      } else if (e.key === ' ' || e.key === 'k' || e.key === 'K') toggle()
      else if (e.key === 'ArrowRight') transport.seekBy(5)
      else if (e.key === 'ArrowLeft') transport.seekBy(-5)
      else if (e.key === 'l' || e.key === 'L') transport.seekBy(10)
      else if (e.key === 'j' || e.key === 'J') transport.seekBy(-10)
      else if (e.key === 'ArrowUp') transport.volumeBy(0.05)
      else if (e.key === 'ArrowDown') transport.volumeBy(-0.05)
      else if (e.key === 'n' || e.key === 'N') next(true)
      else if (e.key === 'p' || e.key === 'P') previous()
      else if (e.key === 'm' || e.key === 'M') transport.toggleMute()
      else if (e.key === '/') search?.focus()
      else if (e.key === 'Escape') {
        if (query() !== '') setQuery('')
        else return
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => {
      props.onTransport(null)
      window.removeEventListener('keydown', onKey)
      engine.pause()
      publish({ status: 'stopped' }, true)
    })
  })

  // restore the saved queue once the library is in
  createEffect(
    on(tracks, (list) => {
      if (list.length === 0 || restored) return
      restored = true
      const scene = props.scene
      if (scene !== null) {
        const first = albums()[0]
        if (scene === 'music-album' && first !== undefined)
          setView({ kind: 'album', key: first.key })
        else if (scene === 'music-songs') setView({ kind: 'songs' })
        else if (scene === 'music-albums') setView({ kind: 'albums' })
        if (scene === 'music-now' || scene === 'music-playing') {
          playList(list, list[0])
          if (scene === 'music-now') setView({ kind: 'now' })
        }
        return
      }
      if (queue().length > 0) return
      const byPath = new Map(list.map((t) => [t.path, t]))
      const q = props.prefs.queue
        .map((p) => byPath.get(p))
        .filter((t): t is Track => t !== undefined)
      if (q.length === 0) return
      setQueue(q)
      setIndex(Math.min(props.prefs.index, q.length - 1))
    }),
  )

  // the app asks us to play something (argv, a playlist, a drop)
  createEffect(
    on(
      () => props.request,
      (req) => {
        if (req === null) return
        restored = true
        setQuery('')
        if (req.append) {
          const q = [...queue(), ...req.tracks]
          const wasEmpty = queue().length === 0
          setQueue(q)
          if (wasEmpty) {
            setIndex(0)
            play()
          }
          toast(`Added ${plural(req.tracks.length, 'song')}`)
          return
        }
        if (req.external) setView({ kind: 'now' })
        else if (req.start !== undefined) {
          const start = req.start
          const album = albums().find((a) => a.tracks.includes(start))
          if (album !== undefined) setView({ kind: 'album', key: album.key })
        }
        playList(req.tracks, req.start)
      },
    ),
  )

  createEffect(() => {
    const v = view().kind
    props.onPrefs({
      queue: queue().map((t) => t.path),
      index: index(),
      view: v === 'songs' || v === 'artists' || v === 'playlists' || v === 'queue' ? v : 'albums',
    })
  })

  createEffect(() => {
    engine.volume = volume()
    publish({ volume: volume() })
  })
  createEffect(() => publish({ repeat: repeat(), shuffle: shuffle() }))

  createEffect(
    on(current, (track) => {
      if (track === undefined) return
      engine.load(url('raw', track.path))
      setTime(0)
      setDuration(track.duration ?? 0)
      const nextTrack = queue()[nextIndex(index(), queue().length, repeat(), false) ?? -1]
      engine.preload(
        nextTrack === undefined || nextTrack === track ? null : url('raw', nextTrack.path),
      )
    }),
  )

  createEffect(() => {
    const track = current()
    document.title =
      track === undefined
        ? 'ewe Player'
        : `${track.title}${track.artist === '' ? '' : ` · ${track.artist}`}`
    if (track === undefined) return
    const id = `${index()}:${track.path}`
    publish(
      {
        metadata: {
          id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          length: track.duration,
          url: track.path,
          trackNumber: track.track,
        },
        canNext: queue().length > 1 || repeat() !== 'off',
        canPrevious: queue().length > 0,
      },
      true,
    )
    if (track.cover) {
      void coverArtFile(track.path).then((art) => {
        if (art !== null && current()?.path === track.path)
          publish({
            metadata: {
              id,
              title: track.title,
              artist: track.artist,
              album: track.album,
              length: track.duration,
              url: track.path,
              trackNumber: track.track,
              artUrl: art,
            },
          })
      })
    }
  })

  const albumOf = (key: string): Album | undefined => albums().find((a) => a.key === key)
  const artistOf = (name: string): Artist | undefined => artists().find((a) => a.name === name)
  const openedAlbum = () => {
    const v = view()
    return v.kind === 'album' ? albumOf(v.key) : undefined
  }
  const openedArtist = () => {
    const v = view()
    return v.kind === 'artist' ? artistOf(v.name) : undefined
  }

  const Cover = (p: {
    track: Track | null
    label: string
    size?: 'sm' | 'lg' | 'xl' | undefined
  }): JSX.Element => {
    const [failed, setFailed] = createSignal(false)
    createEffect(
      on(
        () => p.track?.path,
        () => setFailed(false),
        { defer: true },
      ),
    )
    const show = () => p.track !== null && p.track.cover && !failed()
    return (
      <span class={`mu-cover ${p.size ?? ''}`} style={{ '--h': String(hue(p.label)) }}>
        <Icon name="music" size={p.size === 'sm' ? 14 : p.size === 'xl' ? 48 : 28} />
        <Show when={show()}>
          <img
            src={url('cover', p.track?.path ?? '')}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </Show>
      </span>
    )
  }

  const TrackRows = (p: {
    list: Track[]
    showAlbum?: boolean
    numbers?: boolean
    removable?: boolean
  }): JSX.Element => (
    <div class="mu-table" role="list">
      <Index each={p.list}>
        {(track, i) => {
          const isCurrent = () =>
            current()?.path === track().path && (!(p.removable ?? false) || index() === i)
          return (
            <div
              class="mu-track"
              classList={{ current: isCurrent() }}
              role="listitem"
              tabindex="0"
              data-path={track().path}
              onDblClick={() => playList(p.list, track())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') playList(p.list, track())
              }}
            >
              <span class="mu-num">
                <Show
                  when={isCurrent() && playing()}
                  fallback={
                    <>
                      <span class="mu-index">
                        {p.numbers === true ? (track().track ?? i + 1) : i + 1}
                      </span>
                      <button
                        class="mu-play-row"
                        aria-label={`Play ${track().title}`}
                        onClick={() => playList(p.list, track())}
                      >
                        <Icon name="play" size={12} />
                      </button>
                    </>
                  }
                >
                  <Icon name="audio-lines" size={14} class="mu-eq" />
                </Show>
              </span>
              <span class="mu-title-cell">
                <Show when={p.showAlbum ?? true}>
                  <Cover track={track()} label={track().album || track().title} size="sm" />
                </Show>
                <span class="mu-title-text">
                  <span class="mu-title" dir="auto">
                    {track().title}
                  </span>
                  <span class="mu-sub" dir="auto">
                    {track().artist || 'Unknown artist'}
                  </span>
                </span>
              </span>
              <Show when={p.showAlbum ?? true}>
                <span class="mu-album-cell" dir="auto">
                  {track().album}
                </span>
              </Show>
              <span class="mu-time">{formatDuration(track().duration)}</span>
              <Show when={p.removable ?? false}>
                <IconButton
                  icon="x"
                  label="Remove from queue"
                  size="sm"
                  quiet
                  class="mu-remove"
                  onClick={() => {
                    const q = queue().filter((_, k) => k !== i)
                    let idx = index()
                    if (i < idx) idx -= 1
                    else if (i === idx) idx = Math.min(idx, q.length - 1)
                    setQueue(q)
                    setIndex(Math.max(0, idx))
                  }}
                />
              </Show>
            </div>
          )
        }}
      </Index>
    </div>
  )

  const AlbumGrid = (p: { list: Album[] }): JSX.Element => (
    <div class="mu-grid">
      <For each={p.list}>
        {(album) => (
          <button class="mu-tile" onClick={() => setView({ kind: 'album', key: album.key })}>
            <Cover track={album.cover} label={album.title || album.artist} />
            <span class="mu-tile-title" dir="auto">
              {album.title || 'Unknown album'}
            </span>
            <span class="mu-tile-sub" dir="auto">
              {album.artist || 'Unknown artist'}
            </span>
          </button>
        )}
      </For>
    </div>
  )

  const AlbumHeader = (p: { album: Album }): JSX.Element => {
    const total = () => p.album.tracks.reduce((s, t) => s + (t.duration ?? 0), 0)
    return (
      <div class="mu-hero">
        <Cover track={p.album.cover} label={p.album.title || p.album.artist} size="lg" />
        <div class="mu-hero-text">
          <span class="mu-overline">Album</span>
          <h1 dir="auto">{p.album.title || 'Unknown album'}</h1>
          <span class="mu-sub" dir="auto">
            {joinParts([
              p.album.artist || 'Unknown artist',
              p.album.year === null ? '' : String(p.album.year),
              plural(p.album.tracks.length, 'song'),
              formatDuration(total()),
            ])}
          </span>
          <div class="mu-actions">
            <Button kind="primary" icon="play" onClick={() => playList(p.album.tracks, undefined)}>
              Play
            </Button>
            <Button
              icon="shuffle"
              onClick={() => {
                props.onPrefs({ shuffle: true })
                playList(p.album.tracks, undefined)
              }}
            >
              Shuffle
            </Button>
            <Button
              kind="ghost"
              icon="list-plus"
              onClick={() => setQueue((q) => [...q, ...p.album.tracks])}
            >
              Add to queue
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const NowPlaying = (): JSX.Element => (
    <Show when={current()} fallback={<div class="mu-empty">Nothing is playing.</div>}>
      {(track) => (
        <>
          <div class="mu-hero mu-now-hero">
            <Cover track={track()} label={track().album || track().title} size="xl" />
            <div class="mu-hero-text">
              <span class="mu-overline">Now playing</span>
              <h1 dir="auto">{track().title}</h1>
              <span class="mu-sub" dir="auto">
                {joinParts([track().artist || 'Unknown artist', track().album])}
              </span>
              <span class="mu-sub" dir="auto">
                {track().path}
              </span>
            </div>
          </div>
          <TrackRows list={queue()} removable />
        </>
      )}
    </Show>
  )

  const NAV: { kind: MainView; label: string; icon: IconName; count: () => number }[] = [
    { kind: 'albums', label: 'Albums', icon: 'disc', count: () => albums().length },
    { kind: 'artists', label: 'Artists', icon: 'users', count: () => artists().length },
    { kind: 'songs', label: 'Songs', icon: 'music', count: () => tracks().length },
    {
      kind: 'playlists',
      label: 'Playlists',
      icon: 'list-music',
      count: () => props.library?.playlists.length ?? 0,
    },
    { kind: 'queue', label: 'Queue', icon: 'list', count: () => queue().length },
  ]

  const navKind = (): MainView | 'now' => {
    const v = view()
    if (v.kind === 'album') return 'albums'
    if (v.kind === 'artist') return 'artists'
    return v.kind
  }

  const heading = () => {
    if (query() !== '') return 'Search'
    const album = openedAlbum()
    if (album !== undefined) return album.title || 'Album'
    const artist = openedArtist()
    if (artist !== undefined) return artist.name || 'Unknown artist'
    if (view().kind === 'now') return 'Now playing'
    return NAV.find((n) => n.kind === navKind())?.label ?? 'Music'
  }

  // the window's width picks the nav: a labelled column, an icon rail (< 720) or a
  // segmented control over the list (< 520)
  const [width, setWidth] = createSignal(1280)
  const navMode = () => (width() < 520 ? 'top' : width() < 720 ? 'rail' : 'column')
  const scanning = () => props.library?.scanning ?? false

  const empty = () => (props.library?.tracks.length ?? 0) === 0 && queue().length === 0
  const rootLabel = () => props.library?.roots[0]?.replace(/^\/home\/[^/]+/, '~') ?? ''

  const queueMenu = (): MenuEntry[] => [
    {
      type: 'item',
      id: 'save',
      label: 'Save queue as playlist…',
      icon: 'save',
      disabled: queue().length === 0,
      run: () => props.onSavePlaylist(queue()),
    },
    {
      type: 'item',
      id: 'open',
      label: 'Open playlist…',
      icon: 'folder-open',
      run: () => props.onOpenPlaylist(null),
    },
    {
      type: 'item',
      id: 'files',
      label: 'Add files…',
      icon: 'plus',
      run: () => props.onOpenFiles(),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'clear',
      label: 'Clear queue',
      icon: 'trash-2',
      danger: true,
      disabled: queue().length === 0,
      run: () => {
        engine.stop()
        setQueue([])
        setIndex(0)
        setPlaying(false)
      },
    },
    // no nav column in a narrow window: its Rescan button lives here
    ...(navMode() === 'top'
      ? ([
          { type: 'separator' },
          {
            type: 'item',
            id: 'rescan',
            label: scanning() ? 'Scanning…' : 'Rescan the music folder',
            icon: 'rotate-cw',
            disabled: scanning(),
            run: () => props.onRescan(),
          },
        ] satisfies MenuEntry[])
      : []),
  ]

  return (
    <div
      class="mu"
      classList={{ rail: navMode() === 'rail', top: navMode() === 'top' }}
      ref={(el) => {
        const ro = new ResizeObserver(() => setWidth(el.clientWidth))
        ro.observe(el)
        onCleanup(() => ro.disconnect())
      }}
    >
      <Show when={navMode() !== 'top'}>
        <aside class="mu-nav">
          <For each={NAV}>
            {(item) => (
              <button
                class="mu-nav-item"
                classList={{ active: navKind() === item.kind && query() === '' }}
                data-view={item.kind}
                aria-label={item.label}
                data-tooltip={navMode() === 'rail' ? item.label : undefined}
                onClick={() => {
                  setQuery('')
                  setView({ kind: item.kind })
                }}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                <span class="mu-count">{item.count()}</span>
              </button>
            )}
          </For>
          <Show when={current()}>
            <button
              class="mu-nav-item"
              classList={{ active: view().kind === 'now' && query() === '' }}
              aria-label="Now playing"
              data-tooltip={navMode() === 'rail' ? 'Now playing' : undefined}
              onClick={() => {
                setQuery('')
                setView({ kind: 'now' })
              }}
            >
              <Icon name="audio-lines" />
              <span>Now playing</span>
            </button>
          </Show>
          <span class="mu-grow" />
          <Show
            when={navMode() === 'column'}
            fallback={
              <IconButton
                icon="rotate-cw"
                label={scanning() ? 'Scanning…' : `Rescan ${rootLabel() || 'the music folder'}`}
                class="mu-rescan-icon"
                disabled={scanning()}
                onClick={() => props.onRescan()}
              />
            }
          >
            <div class="mu-root" title={props.library?.roots.join('\n')}>
              <Icon name="folder" size={14} />
              <span>{rootLabel()}</span>
            </div>
            <Button
              small
              kind="ghost"
              icon="rotate-cw"
              class="mu-rescan"
              disabled={scanning()}
              onClick={() => props.onRescan()}
            >
              {scanning() ? 'Scanning…' : 'Rescan'}
            </Button>
          </Show>
        </aside>
      </Show>

      <main class="mu-main">
        <Show when={navMode() === 'top'}>
          <div class="mu-tabs">
            <Segmented
              small
              label="Music"
              value={query() === '' ? navKind() : ''}
              options={NAV.map((n) => ({ value: n.kind, label: n.label }))}
              onChange={(v) => {
                setQuery('')
                setView({ kind: v as MainView })
              }}
            />
          </div>
        </Show>
        <header class="mu-head">
          <Show when={view().kind === 'album' || view().kind === 'artist'}>
            <IconButton
              icon="arrow-left"
              label="Back"
              onClick={() => setView({ kind: navKind() === 'now' ? 'albums' : navKind() })}
            />
          </Show>
          <h2>{heading()}</h2>
          <label class="mu-search">
            <Icon name="search" size={14} />
            <input
              ref={search}
              value={query()}
              placeholder="Search songs, artists, albums"
              spellcheck={false}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('')
                  e.currentTarget.blur()
                } else if (e.key === 'Enter') playList(found(), found()[0])
              }}
            />
          </label>
          <IconButton
            icon="ellipsis"
            label="Queue and playlists"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setMenuAt({ x: r.right, y: r.bottom + 4 })
            }}
          />
        </header>

        <div class="mu-content">
          <Show
            when={!empty()}
            fallback={
              <div class="mu-empty">
                <span class="mu-empty-art">
                  <Icon name="music" size={36} />
                </span>
                <span class="mu-empty-title">
                  {props.library === null ||
                  (props.library.scanning && props.library.tracks.length === 0)
                    ? 'Looking for music…'
                    : 'No music yet'}
                </span>
                <span class="mu-empty-desc">
                  Put songs in {rootLabel() || 'your Music folder'} and they show up here.
                </span>
                <div class="mu-actions">
                  <Button small icon="folder-open" onClick={openFolder}>
                    Open folder
                  </Button>
                  <Button small kind="ghost" icon="rotate-cw" onClick={() => props.onRescan()}>
                    Rescan
                  </Button>
                  <Button small kind="ghost" icon="plus" onClick={() => props.onOpenFiles()}>
                    Play files…
                  </Button>
                </div>
              </div>
            }
          >
            <Switch>
              <Match when={query() !== ''}>
                <Show
                  when={found().length > 0}
                  fallback={<div class="mu-empty">Nothing matches “{query()}”</div>}
                >
                  <TrackRows list={found()} />
                </Show>
              </Match>
              <Match when={openedAlbum()}>
                {(album) => (
                  <>
                    <AlbumHeader album={album()} />
                    <TrackRows list={album().tracks} showAlbum={false} numbers />
                  </>
                )}
              </Match>
              <Match when={openedArtist()}>
                {(artist) => <AlbumGrid list={artist().albums} />}
              </Match>
              <Match when={view().kind === 'now'}>
                <NowPlaying />
              </Match>
              <Match when={view().kind === 'queue'}>
                <Show
                  when={queue().length > 0}
                  fallback={
                    <div class="mu-empty">The queue is empty. Play an album or add files.</div>
                  }
                >
                  <div class="mu-actions mu-queue-actions">
                    <Button small icon="save" onClick={() => props.onSavePlaylist(queue())}>
                      Save as playlist…
                    </Button>
                    <Button
                      small
                      kind="ghost"
                      icon="shuffle"
                      onClick={() => setShuffle(!shuffle())}
                    >
                      {shuffle() ? 'Unshuffle' : 'Shuffle'}
                    </Button>
                  </div>
                  <TrackRows list={queue()} removable />
                </Show>
              </Match>
              <Match when={view().kind === 'playlists'}>
                <div class="mu-actions mu-queue-actions">
                  <Button small icon="folder-open" onClick={() => props.onOpenPlaylist(null)}>
                    Open playlist…
                  </Button>
                  <Button
                    small
                    kind="ghost"
                    icon="save"
                    disabled={queue().length === 0}
                    onClick={() => props.onSavePlaylist(queue())}
                  >
                    Save queue as playlist…
                  </Button>
                </div>
                <Show
                  when={(props.library?.playlists.length ?? 0) > 0}
                  fallback={
                    <div class="mu-empty">
                      No .m3u playlists in {rootLabel() || 'your Music folder'} yet.
                    </div>
                  }
                >
                  <div class="mu-artists">
                    <For each={props.library?.playlists ?? []}>
                      {(path) => (
                        <button
                          class="mu-artist"
                          onClick={() => props.onOpenPlaylist(path)}
                          title={path}
                        >
                          <span class="mu-cover sm" style={{ '--h': String(hue(path)) }}>
                            <Icon name="list-music" size={14} />
                          </span>
                          <span class="mu-title" dir="auto">
                            {stemOf(path.slice(path.lastIndexOf('/') + 1))}
                          </span>
                          <span class="mu-sub" dir="auto">
                            {path.replace(/^\/home\/[^/]+/, '~')}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Match>
              <Match when={view().kind === 'songs'}>
                <TrackRows list={tracks()} />
              </Match>
              <Match when={view().kind === 'albums'}>
                <AlbumGrid list={albums()} />
              </Match>
              <Match when={view().kind === 'artists'}>
                <div class="mu-artists">
                  <For each={artists()}>
                    {(artist) => (
                      <button
                        class="mu-artist"
                        onClick={() => setView({ kind: 'artist', name: artist.name })}
                      >
                        <Cover
                          track={artist.albums[0]?.cover ?? null}
                          label={artist.name}
                          size="sm"
                        />
                        <span class="mu-title" dir="auto">
                          {artist.name || 'Unknown artist'}
                        </span>
                        <span class="mu-sub" dir="auto">
                          {joinParts([
                            plural(artist.albums.length, 'album'),
                            plural(artist.tracks, 'song'),
                          ])}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Match>
            </Switch>
          </Show>
        </div>
      </main>

      <footer class="mu-bar" classList={{ idle: current() === undefined }}>
        <div class="mu-now">
          <Show when={current()}>
            {(track) => (
              <>
                <button
                  class="mu-now-cover"
                  aria-label="Now playing"
                  onClick={() => setView({ kind: 'now' })}
                >
                  <Cover track={track()} label={track().album || track().title} />
                </button>
                <span class="mu-now-text">
                  <span class="mu-title" dir="auto">
                    {track().title}
                  </span>
                  <span class="mu-sub" dir="auto">
                    {[track().artist, track().album].filter((x) => x !== '').join(' — ')}
                  </span>
                </span>
              </>
            )}
          </Show>
        </div>
        <div class="mu-transport">
          <div class="mu-buttons">
            <IconButton
              icon="shuffle"
              label="Shuffle"
              active={shuffle()}
              class="mu-shuffle"
              onClick={() => setShuffle(!shuffle())}
            />
            <IconButton icon="skip-back" label="Previous" onClick={previous} />
            <button class="mu-play" aria-label={playing() ? 'Pause' : 'Play'} onClick={toggle}>
              <Icon name={playing() ? 'pause' : 'play'} size={18} />
            </button>
            <IconButton icon="skip-forward" label="Next" onClick={() => next(true)} />
            <IconButton
              icon={repeat() === 'one' ? 'repeat-1' : 'repeat'}
              label={`Repeat ${repeat()}`}
              active={repeat() !== 'off'}
              class="mu-repeat"
              onClick={cycleRepeat}
            />
          </div>
          <div class="mu-seek">
            <span class="mu-time">{formatDuration(time())}</span>
            <input
              type="range"
              min="0"
              max={Math.max(1, duration())}
              step="0.1"
              value={time()}
              aria-label="Seek"
              style={{ '--p': `${duration() > 0 ? (time() / duration()) * 100 : 0}%` }}
              onInput={(e) => transport.seekTo(Number(e.currentTarget.value))}
            />
            <span class="mu-time">{formatDuration(duration())}</span>
          </div>
          <Show when={error()}>
            <span class="mu-error">{error()}</span>
          </Show>
        </div>
        <div class="mu-volume">
          <IconButton
            icon={volume() === 0 ? 'volume-x' : 'volume-2'}
            label={volume() === 0 ? 'Unmute' : 'Mute'}
            onClick={() => transport.toggleMute()}
          />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume()}
            aria-label="Volume"
            style={{ '--p': `${volume() * 100}%` }}
            onInput={(e) => props.onPrefs({ volume: Number(e.currentTarget.value) })}
          />
        </div>
      </footer>

      <Show when={menuAt()}>
        {(at) => <Menu items={queueMenu()} at={at()} onClose={() => setMenuAt(null)} />}
      </Show>
    </div>
  )
}
