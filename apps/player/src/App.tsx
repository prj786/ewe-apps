import {
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  comboKey,
  baseName,
  compareTracks,
  dirName,
  isRemoteUrl,
  linksInText,
  rememberPosition,
  sortMedia,
  toMediaItem,
  type Launch,
  type MediaItem,
  type MediaServer,
  type Track,
} from '@ewe/shared'
import {
  Button,
  Dialog,
  Field,
  Icon,
  IconButton,
  Menu,
  Segmented,
  Toasts,
  Toolbar,
  applyShotSize,
  getAppVersion,
  getLaunch,
  getMediaServer,
  onLaunch,
  toast,
  type MenuEntry,
} from '@ewe/ui'
import {
  hyprFloat,
  listMedia,
  musicLibrary,
  musicRescan,
  onMprisCommand,
  onMusicChanged,
  playerPlaces,
  playlistLoad,
  playlistSave,
  trackInfo,
  type Library,
  type Places,
  type Transport,
} from './bridge'
import { MusicView, type PlayRequest } from './music/MusicView'
import { StartScreen } from './start/StartScreen'
import { loadState, saveState, type MusicPrefs, type PlayerState, type VideoPrefs } from './store'
import { VideoPlayer } from './video/VideoPlayer'

const MINI_SIZE = new LogicalSize(480, 300)

/** `defaultPath` only when we know one (exactOptionalPropertyTypes). */
const startIn = (dir: string | undefined): { defaultPath?: string } =>
  dir === undefined ? {} : { defaultPath: dir }

export function App(): JSX.Element {
  const initial = loadState()
  const [mode, setMode] = createSignal<PlayerState['mode']>(initial.mode)
  const [videoPrefs, setVideoPrefs] = createSignal<VideoPrefs>(initial.video)
  const [musicPrefs, setMusicPrefs] = createSignal<MusicPrefs>(initial.music)
  const [positions, setPositions] = createSignal(initial.positions)
  const [server, setServer] = createSignal<MediaServer | null>(null)
  const [library, setLibrary] = createSignal<Library | null>(null)
  const [places, setPlaces] = createSignal<Places | null>(null)
  const [queue, setQueue] = createSignal<MediaItem[]>([])
  const [index, setIndex] = createSignal(0)
  const [folder, setFolder] = createSignal<MediaItem[]>([])
  const [autoplay, setAutoplay] = createSignal(true)
  const [request, setRequest] = createSignal<PlayRequest | null>(null)
  const [fullscreen, setFullscreen] = createSignal(false)
  const [mini, setMini] = createSignal(false)
  const [urlDialog, setUrlDialog] = createSignal(false)
  const [urlText, setUrlText] = createSignal('')
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null)
  const [dropping, setDropping] = createSignal(false)
  const [version, setVersion] = createSignal('')
  // `--scene=<name>`: a screenshot hook (scripts/shot.sh) that opens a given state
  const [scene, setScene] = createSignal<string | null>(null)
  let transport: Transport | null = null
  let normalSize: LogicalSize | null = null
  const win = getCurrentWindow()

  const view = (): 'start' | 'video' | 'music' =>
    mode() === 'music' ? 'music' : queue().length === 0 ? 'start' : 'video'

  // --- persistence --------------------------------------------------------------------
  createEffect(() => {
    saveState({ mode: mode(), video: videoPrefs(), music: musicPrefs(), positions: positions() })
  })
  const patchVideo = (patch: Partial<VideoPrefs>) => setVideoPrefs((p) => ({ ...p, ...patch }))
  const patchMusic = (patch: Partial<MusicPrefs>) => setMusicPrefs((p) => ({ ...p, ...patch }))

  // --- opening things -----------------------------------------------------------------
  const libraryTrack = (path: string): Track | undefined =>
    library()?.tracks.find((t) => t.path === path)

  const albumTracksOf = (track: Track): Track[] => {
    const key = `${(track.albumArtist || track.artist).toLowerCase()}\u0000${track.album.toLowerCase()}`
    return (library()?.tracks ?? [])
      .filter(
        (t) => `${(t.albumArtist || t.artist).toLowerCase()}\u0000${t.album.toLowerCase()}` === key,
      )
      .sort(compareTracks)
  }

  const playAudio = async (items: MediaItem[], append: boolean) => {
    const known = items.map((i) => libraryTrack(i.path))
    const missing = items.filter((_, k) => known[k] === undefined).map((i) => i.path)
    const read = missing.length === 0 ? [] : await trackInfo(missing)
    const byPath = new Map(read.map((t) => [t.path, t]))
    let tracks = items
      .map((i, k) => known[k] ?? byPath.get(i.path))
      .filter((t): t is Track => t !== undefined)
    const external = known.every((t) => t === undefined)
    let start = tracks[0]
    if (!append && tracks.length === 1 && start !== undefined && !external) {
      // one song from the library: play its album from there
      tracks = albumTracksOf(start)
      start = tracks.find((t) => t.path === items[0]?.path) ?? start
    }
    if (tracks.length === 0) {
      toast('Nothing playable there', { kind: 'warning' })
      return
    }
    setMode('music')
    setRequest({ tracks, start, external, append, nonce: Date.now() })
  }

  const playVideo = async (items: MediaItem[], append: boolean, singlePath: string | null) => {
    if (append && queue().length > 0) {
      setQueue((q) => [...q, ...items])
      toast(
        `Added ${items.length === 1 ? (items[0]?.name ?? 'one item') : `${items.length} items`}`,
      )
      return
    }
    setAutoplay(true)
    setQueue(items)
    setIndex(0)
    setMode('video')
    if (singlePath !== null) {
      const siblings = await listMedia([dirName(singlePath)])
      setFolder(
        sortMedia(
          siblings.map((f) => ({
            path: f.path,
            name: baseName(f.path),
            kind: f.kind,
            remote: false,
          })),
        ),
      )
    } else setFolder([])
  }

  const openTargets = async (paths: string[], urls: string[], append: boolean) => {
    const lists = paths.filter((p) => /\.m3u8?$/i.test(p))
    const rest = paths.filter((p) => !/\.m3u8?$/i.test(p))
    const files = rest.length === 0 ? [] : await listMedia(rest)
    const items: MediaItem[] = files.map((f) => ({
      path: f.path,
      name: baseName(f.path),
      kind: f.kind,
      remote: false,
    }))
    for (const list of lists) {
      try {
        const entries = await playlistLoad(list)
        for (const e of entries) {
          const item = toMediaItem(e.path)
          if (item === null) continue
          // a link's #EXTINF title is all it has until it is opened
          if (item.remote && e.title !== null && e.title.trim() !== '') item.title = e.title
          if (item.remote && e.duration !== null && e.duration > 0) item.duration = e.duration
          items.push(item)
        }
      } catch {
        toast(`Could not read ${baseName(list)}`, { kind: 'danger' })
      }
    }
    for (const u of urls) {
      const item = toMediaItem(u)
      if (item !== null) items.push(item)
    }
    if (items.length === 0) {
      toast(paths.length + urls.length === 0 ? 'Nothing to open' : 'Nothing playable there', {
        kind: 'warning',
      })
      return
    }
    const allAudio = items.every((i) => i.kind === 'audio' && !i.remote)
    if (allAudio) await playAudio(items, append)
    else {
      const single =
        rest.length === 1 && lists.length === 0 && urls.length === 0 && files.length === 1
          ? (files[0]?.path ?? null)
          : null
      await playVideo(items, append, single)
    }
  }

  const handleLaunch = (l: Launch) => {
    const append = l.flags.some((f) => f === '--enqueue' || f.startsWith('--enqueue='))
    void openTargets(l.paths, l.urls ?? [], append)
  }

  const openFiles = async () => {
    const picked = await openDialog({
      multiple: true,
      title: 'Open',
      ...startIn(mode() === 'music' ? places()?.music : places()?.videos),
      filters: [
        {
          name: 'Video and music',
          extensions: [
            'mp4',
            'm4v',
            'mkv',
            'webm',
            'mov',
            'avi',
            'wmv',
            'flv',
            'mpg',
            'mpeg',
            'ts',
            'm2ts',
            'ogv',
            '3gp',
            'mp3',
            'flac',
            'ogg',
            'oga',
            'opus',
            'wav',
            'm4a',
            'aac',
            'wma',
            'aiff',
            'mka',
            'm3u',
            'm3u8',
          ],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    const list = picked === null ? [] : Array.isArray(picked) ? picked : [picked]
    if (list.length > 0) await openTargets(list, [], false)
  }

  const openFolder = async () => {
    const picked = await openDialog({
      directory: true,
      title: 'Open folder',
      ...startIn(places()?.videos),
    })
    if (typeof picked === 'string') await openTargets([picked], [], false)
  }

  const openUrl = () => {
    const text = urlText().trim()
    setUrlDialog(false)
    if (!isRemoteUrl(text)) {
      if (text !== '') toast('That is not a web address', { kind: 'warning' })
      return
    }
    setUrlText('')
    void openTargets([], [text], false)
  }

  const openPlaylist = async (path: string | null) => {
    let target = path
    if (target === null) {
      const picked = await openDialog({
        multiple: false,
        title: 'Open playlist',
        ...startIn(places()?.playlists),
        filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8'] }],
      })
      if (typeof picked !== 'string') return
      target = picked
    }
    await openTargets([target], [], false)
  }

  const savePlaylist = async (tracks: Track[]) => {
    const picked = await saveDialog({
      title: 'Save playlist',
      defaultPath: `${places()?.playlists ?? ''}/Playlist.m3u`,
      filters: [{ name: 'Playlist', extensions: ['m3u'] }],
    })
    if (picked === null) return
    const path = /\.m3u8?$/i.test(picked) ? picked : `${picked}.m3u`
    try {
      await playlistSave(
        path,
        tracks.map((t) => ({
          path: t.path,
          title: t.artist === '' ? t.title : `${t.artist} - ${t.title}`,
          duration: t.duration,
        })),
      )
      toast(`Saved ${baseName(path)}`, { kind: 'success' })
      void musicRescan().then(setLibrary)
    } catch (e) {
      toast(`Could not save: ${String(e)}`, { kind: 'danger' })
    }
  }

  // --- window: fullscreen and the mini player ----------------------------------------
  const applyFullscreen = async (on: boolean) => {
    setFullscreen(on)
    try {
      await win.setFullscreen(on)
    } catch {
      return
    }
  }

  const applyMini = async (on: boolean) => {
    setMini(on)
    try {
      if (on) {
        const scale = await win.scaleFactor()
        normalSize = (await win.innerSize()).toLogical(scale)
        await hyprFloat(true)
        await win.setAlwaysOnTop(true)
        await win.setSize(MINI_SIZE)
        await win.setTitle('ewe Player — Mini')
      } else {
        await win.setAlwaysOnTop(false)
        await hyprFloat(false)
        if (normalSize !== null) await win.setSize(normalSize)
        await win.setTitle('ewe Player')
      }
    } catch {
      return
    }
  }

  // --- start-up -----------------------------------------------------------------------
  onMount(() => {
    void getAppVersion().then((v) => setVersion(v.version))
    void getMediaServer().then(setServer)
    void playerPlaces().then(setPlaces)
    // the listener first, then the first call (which starts the scan)
    let offMusic: (() => void) | null = null
    void onMusicChanged(setLibrary)
      .then((off) => {
        offMusic = off
        return musicLibrary()
      })
      .then((lib) => {
        setLibrary(lib)
        if (lib.scanning)
          setTimeout(() => {
            if (library()?.scanning ?? false) void musicLibrary().then(setLibrary)
          }, 4000)
      })
    void getLaunch().then((l) => {
      applyShotSize(l.flags)
      const wanted = l.flags.find((f) => f.startsWith('--scene='))?.slice('--scene='.length)
      if (wanted !== undefined) {
        setScene(wanted)
        if (wanted.startsWith('music')) setMode('music')
      }
      if (l.paths.length > 0 || (l.urls?.length ?? 0) > 0) handleLaunch(l)
    })
    const offs = [
      onLaunch(handleLaunch),
      onMprisCommand((c) => {
        const t = transport
        switch (c.action) {
          case 'play':
            t?.play()
            break
          case 'pause':
            t?.pause()
            break
          case 'play-pause':
            t?.toggle()
            break
          case 'stop':
            t?.stop()
            break
          case 'next':
            t?.next()
            break
          case 'previous':
            t?.previous()
            break
          case 'seek':
            if (typeof c.value === 'number') t?.seekBy(c.value)
            break
          case 'set-position':
            if (typeof c.value === 'number') t?.seekTo(c.value)
            break
          case 'volume':
            if (typeof c.value === 'number') t?.setVolume(c.value)
            break
          case 'rate':
            if (typeof c.value === 'number') t?.setRate(c.value)
            break
          case 'repeat':
            if (c.value === 'off' || c.value === 'all' || c.value === 'one') t?.setRepeat(c.value)
            break
          case 'shuffle':
            if (typeof c.value === 'boolean') t?.setShuffle(c.value)
            break
          case 'fullscreen':
            if (typeof c.value === 'boolean') void applyFullscreen(c.value)
            break
          case 'open-uri':
            if (typeof c.value === 'string') {
              const u = c.value
              if (u.startsWith('file://'))
                void openTargets([decodeURIComponent(u.slice(7))], [], false)
              else void openTargets([], [u], false)
            }
            break
          case 'raise':
            break
        }
      }),
    ]
    let offDrop: (() => void) | null = null
    void getCurrentWebview()
      // eslint-disable-next-line solid/reactivity -- a plain event handler
      .onDragDropEvent((e) => {
        if (e.payload.type === 'enter' || e.payload.type === 'over') setDropping(true)
        else if (e.payload.type === 'leave') setDropping(false)
        else if (e.payload.type === 'drop') {
          setDropping(false)
          // a link dragged out of a browser arrives as a "path" that is a URL
          const urls = e.payload.paths.filter((p) => isRemoteUrl(p))
          const paths = e.payload.paths.filter((p) => !isRemoteUrl(p))
          void openTargets(paths, urls, false)
        }
      })
      .then((off) => {
        offDrop = off
      })
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      // the letter on the key, whatever the layout types
      const k = comboKey(e)
      if (k === 'o') void openFiles()
      else if (k === 'l') setUrlDialog(true)
      else if (k === '1') setMode('video')
      else if (k === '2') setMode('music')
      else if (k === 'q') void win.close()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => {
      offs.forEach((off) => off())
      offMusic?.()
      offDrop?.()
      window.removeEventListener('keydown', onKey)
    })
  })

  // a link dropped as text (selected text, some browsers' tabs): WebKit's own drop, which
  // Tauri leaves alone because it is no uri-list
  const onTextDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('text/plain') === true && !e.defaultPrevented)
      e.preventDefault()
  }
  const onTextDrop = (e: DragEvent) => {
    if (e.defaultPrevented) return // the playlist's own reordering
    const dt = e.dataTransfer
    if (dt === null) return
    const urls = linksInText(dt.getData('text/uri-list') || dt.getData('text/plain'))
    if (urls.length === 0) return
    e.preventDefault()
    setDropping(false)
    void openTargets([], urls, false)
  }

  /** the queue learns what a link is (title, picture, length) */
  const patchItem = (path: string, patch: Partial<MediaItem>) =>
    setQueue((q) => q.map((i) => (i.path === path ? { ...i, ...patch } : i)))
  /** a link that was a playlist: its entries take its place */
  const expandItem = (path: string, entries: MediaItem[]) => {
    const q = queue()
    const at = q.findIndex((i) => i.path === path)
    if (at < 0 || entries.length === 0) return
    setQueue([...q.slice(0, at), ...entries, ...q.slice(at + 1)])
    setIndex(at)
    toast(`${entries.length} videos from the playlist`)
  }

  const appMenu = (): MenuEntry[] => [
    {
      type: 'item',
      id: 'open',
      label: 'Open files…',
      icon: 'folder-open',
      hint: 'Ctrl+O',
      run: () => void openFiles(),
    },
    {
      type: 'item',
      id: 'folder',
      label: 'Open folder…',
      icon: 'folder',
      run: () => void openFolder(),
    },
    {
      type: 'item',
      id: 'url',
      label: 'Open URL…',
      icon: 'link',
      hint: 'Ctrl+L',
      run: () => setUrlDialog(true),
    },
    {
      type: 'item',
      id: 'playlist',
      label: 'Open playlist…',
      icon: 'list-music',
      run: () => void openPlaylist(null),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'rescan',
      label: 'Rescan music',
      icon: 'rotate-cw',
      run: () => void musicRescan().then(setLibrary),
    },
    {
      type: 'item',
      id: 'about',
      label: 'About ewe Player',
      icon: 'info',
      run: () =>
        toast(
          `ewe Player ${version()} — GStreamer ${navigator.userAgent.includes('WebKit') ? 'through WebKitGTK' : ''}`,
        ),
    },
  ]

  return (
    <div
      class="app"
      classList={{ fullscreen: fullscreen(), mini: mini(), dropping: dropping() }}
      onDragOver={onTextDragOver}
      onDrop={onTextDrop}
    >
      <header class="app-header">
        <h1 class="app-name">
          <Icon name="play" />
          <span class="app-name-text">ewe Player</span>
        </h1>
        <Segmented
          small
          value={mode()}
          label="Section"
          options={[
            { value: 'video', label: 'Video' },
            { value: 'music', label: 'Music' },
          ]}
          onChange={(v) => setMode(v === 'music' ? 'music' : 'video')}
        />
        <Toolbar label="Window" class="toolbar--header">
          <span class="toolbar-spacer" />
          <IconButton
            icon="folder-open"
            label="Open files (Ctrl+O)"
            onClick={() => void openFiles()}
          />
          <IconButton
            icon="ellipsis"
            label="Menu"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setMenuAt({ x: r.right, y: r.bottom + 4 })
            }}
          />
        </Toolbar>
      </header>
      <main class="app-body">
        <Show when={server()}>
          {(srv) => (
            <Switch>
              <Match when={view() === 'start'}>
                <StartScreen
                  server={srv()}
                  positions={positions()}
                  dropping={dropping()}
                  onOpen={(p) => void openTargets([p], [], false)}
                  onOpenFiles={() => void openFiles()}
                  onOpenFolder={() => void openFolder()}
                  onOpenUrl={() => setUrlDialog(true)}
                  onMusic={() => setMode('music')}
                />
              </Match>
              <Match when={view() === 'video'}>
                <VideoPlayer
                  server={srv()}
                  queue={queue()}
                  index={index()}
                  folder={folder()}
                  autoplay={autoplay()}
                  prefs={videoPrefs()}
                  onPrefs={patchVideo}
                  positions={positions()}
                  onPosition={(path, pos, dur) =>
                    setPositions((p) => rememberPosition(p, path, pos, dur))
                  }
                  fullscreen={fullscreen()}
                  onFullscreen={(on) => void applyFullscreen(on)}
                  mini={mini()}
                  onMini={(on) => void applyMini(on)}
                  onIndex={(i) => {
                    setAutoplay(true)
                    setIndex(i)
                  }}
                  onQueue={(q, i) => {
                    setQueue(q)
                    setIndex(i)
                  }}
                  onItem={patchItem}
                  onExpand={expandItem}
                  onAddFiles={() => void openFiles()}
                  onAddFolder={() => void openFolder()}
                  onOpenUrl={() => setUrlDialog(true)}
                  onTransport={(t) => {
                    transport = t
                  }}
                  onStopped={() => setAutoplay(false)}
                  scene={scene()}
                />
              </Match>
              <Match when={view() === 'music'}>
                <MusicView
                  server={srv()}
                  library={library()}
                  onRescan={() => void musicRescan().then(setLibrary)}
                  prefs={musicPrefs()}
                  onPrefs={patchMusic}
                  request={request()}
                  onTransport={(t) => {
                    transport = t
                  }}
                  onOpenFiles={() => void openFiles()}
                  onOpenPlaylist={(p) => void openPlaylist(p)}
                  onSavePlaylist={(tracks) => void savePlaylist(tracks)}
                  scene={scene()}
                />
              </Match>
            </Switch>
          )}
        </Show>
        <Show when={dropping() && view() !== 'start'}>
          <div class="drop-hint">
            <Icon name="download" size={32} />
            <span>Drop to play</span>
          </div>
        </Show>
      </main>
      <Show when={menuAt()}>
        {(at) => <Menu items={appMenu()} at={at()} onClose={() => setMenuAt(null)} />}
      </Show>
      <Dialog
        open={urlDialog()}
        title="Open a web address"
        description="A page with a video on it (YouTube, Twitch, news sites…), or a link to a video, a song or a stream."
        onClose={() => setUrlDialog(false)}
        actions={
          <>
            <Button kind="ghost" onClick={() => setUrlDialog(false)}>
              Cancel
            </Button>
            <Button kind="primary" onClick={openUrl}>
              Open
            </Button>
          </>
        }
      >
        <Field
          value={urlText()}
          label="Address"
          placeholder="https://…"
          icon="link"
          autofocus
          clearable
          mono
          onInput={setUrlText}
          onSubmit={openUrl}
          onCancel={() => setUrlDialog(false)}
        />
      </Dialog>
      <Toasts />
    </div>
  )
}
