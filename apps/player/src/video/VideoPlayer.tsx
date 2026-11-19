import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  MAX_VOLUME,
  SPEEDS,
  clampVolume,
  decodeFailureMessage,
  formatClock,
  formatSpeed,
  nextIndex,
  previousIndex,
  rawUrl,
  stemOf,
  stepSpeed,
  subtitleLabel,
  type MediaItem,
  type MediaServer,
  type SavedPosition,
} from '@ewe/shared'
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  Segmented,
  addRecent,
  toast,
  type MenuEntry,
} from '@ewe/ui'
import {
  inhibitIdle,
  launchWith,
  probeMedia,
  screenshotFrame,
  subtitleFiles,
  subtitleVtt,
  type Transport,
} from '../bridge'
import { publish } from '../mpris'
import type { FitMode, SubPosition, SubSize, VideoPrefs } from '../store'
import { Playlist } from './Playlist'
import './video.css'

export interface VideoPlayerProps {
  server: MediaServer
  queue: MediaItem[]
  index: number
  folder: MediaItem[]
  /** play as soon as the file is ready */
  autoplay: boolean
  prefs: VideoPrefs
  onPrefs(patch: Partial<VideoPrefs>): void
  positions: Record<string, SavedPosition>
  onPosition(path: string, position: number, duration: number): void
  fullscreen: boolean
  onFullscreen(on: boolean): void
  mini: boolean
  onMini(on: boolean): void
  onIndex(index: number): void
  onQueue(queue: MediaItem[], index: number): void
  onAddFiles(): void
  onAddFolder(): void
  onOpenUrl(): void
  onTransport(transport: Transport | null): void
  onStopped(): void
}

interface SubTrack {
  id: string
  label: string
  kind: 'embedded' | 'file'
  /** file tracks: the source path (for the menu) and the blob URL of its VTT */
  path?: string
  url?: string
}

interface AudioTrackLike {
  id: string
  label: string
  language: string
  enabled: boolean
}

interface AudioTrackListLike {
  length: number
  [index: number]: AudioTrackLike
  addEventListener(type: string, handler: () => void): void
  removeEventListener(type: string, handler: () => void): void
}

const audioTracksOf = (v: HTMLVideoElement): AudioTrackListLike | undefined =>
  (v as unknown as { audioTracks?: AudioTrackListLike }).audioTracks

const HIDE_AFTER = 2500
const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)
const FRAME = 1 / 30
const SUB_LINE: Record<SubPosition, number | 'auto'> = { bottom: 'auto', raised: 78, top: 8 }

export function VideoPlayer(props: VideoPlayerProps): JSX.Element {
  let video!: HTMLVideoElement
  let stage!: HTMLDivElement
  let seekBar!: HTMLDivElement
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let osdTimer: ReturnType<typeof setTimeout> | null = null
  let lastSaved = 0
  let lastPublished = 0
  let audioContext: AudioContext | null = null
  let gain: GainNode | null = null
  let resumeFor: string | null = null

  const item = () => props.queue[props.index]
  const src = createMemo(() => {
    const it = item()
    if (it === undefined) return ''
    return it.remote ? it.path : rawUrl(props.server, it.path)
  })
  const title = () => {
    const it = item()
    return it === undefined ? '' : it.remote ? it.name : stemOf(it.name)
  }

  const [playing, setPlaying] = createSignal(false)
  const [time, setTime] = createSignal(0)
  const [duration, setDuration] = createSignal(0)
  const [buffered, setBuffered] = createSignal<[number, number][]>([])
  const [hover, setHover] = createSignal<{ x: number; time: number } | null>(null)
  const [scrubbing, setScrubbing] = createSignal(false)
  const [visible, setVisible] = createSignal(true)
  const [overControls, setOverControls] = createSignal(false)
  const [speed, setSpeed] = createSignal(1)
  const [subs, setSubs] = createSignal<SubTrack[]>([])
  const [activeSub, setActiveSub] = createSignal<string | null>(null)
  const [audioTracks, setAudioTracks] = createSignal<AudioTrackLike[]>([])
  const [activeAudio, setActiveAudio] = createSignal<string | null>(null)
  const [rotation, setRotation] = createSignal(0)
  const [stageSize, setStageSize] = createSignal({ w: 0, h: 0 })
  const [error, setError] = createSignal<{
    title: string
    detail: string
    suggestLibav: boolean
  } | null>(null)
  const [osd, setOsd] = createSignal<string | null>(null)
  const [resume, setResume] = createSignal<SavedPosition | null>(null)
  const [menu, setMenu] = createSignal<{
    kind: 'speed' | 'subs' | 'audio' | 'view' | 'more'
    at: { x: number; y: number }
  } | null>(null)
  const [waiting, setWaiting] = createSignal(false)

  const volume = () => props.prefs.volume
  const muted = () => props.prefs.muted
  const canNext = () =>
    nextIndex(props.index, props.queue.length, 'off', true) !== null && props.queue.length > 1
  const canPrevious = () => props.queue.length > 1

  const flash = (text: string) => {
    setOsd(text)
    if (osdTimer !== null) clearTimeout(osdTimer)
    osdTimer = setTimeout(() => setOsd(null), 900)
  }

  const poke = () => {
    setVisible(true)
    if (hideTimer !== null) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (playing() && !overControls() && menu() === null && !scrubbing()) setVisible(false)
    }, HIDE_AFTER)
  }

  // --- volume: the element up to 100 %, a gain node above that -------------------------
  const applyVolume = () => {
    const v = muted() ? 0 : volume()
    if (v > 1 || gain !== null) {
      if (gain === null) {
        try {
          audioContext ??= new AudioContext()
          const source = audioContext.createMediaElementSource(video)
          gain = audioContext.createGain()
          source.connect(gain)
          gain.connect(audioContext.destination)
          void audioContext.resume()
        } catch {
          gain = null
        }
      }
      if (gain !== null) {
        video.volume = 1
        gain.gain.value = v
        return
      }
    }
    video.volume = Math.min(1, v)
  }

  const setVolume = (v: number) => {
    const next = clampVolume(v)
    props.onPrefs({ volume: next, muted: false })
    flash(`Volume ${Math.round(next * 100)} %`)
  }

  // --- transport ----------------------------------------------------------------------
  const play = () => void video.play().catch(() => undefined)
  const pause = () => video.pause()
  const toggle = () => {
    if (video.paused) play()
    else pause()
  }
  const seekTo = (s: number) => {
    const d = duration()
    video.currentTime = Math.max(0, d > 0 ? Math.min(d, s) : s)
    setTime(video.currentTime)
    publish({ position: video.currentTime, seeked: true }, true)
  }
  const seekBy = (s: number) => {
    seekTo(video.currentTime + s)
    flash(`${s > 0 ? '+' : '−'}${Math.abs(s)} s`)
  }
  const goTo = (i: number | null) => {
    if (i === null) {
      pause()
      props.onStopped()
      return
    }
    props.onIndex(i)
  }
  const next = (manual: boolean) => goTo(nextIndex(props.index, props.queue.length, 'off', manual))
  const previous = () => {
    if (video.currentTime > 3 || props.queue.length < 2) {
      seekTo(0)
      return
    }
    goTo(previousIndex(props.index, props.queue.length))
  }
  const changeSpeed = (s: number) => {
    setSpeed(s)
    video.playbackRate = s
    flash(formatSpeed(s))
    publish({ rate: s })
  }
  const frameStep = (dir: 1 | -1) => {
    pause()
    seekTo(video.currentTime + dir * FRAME)
  }

  const transport: Transport = {
    toggle,
    play,
    pause,
    stop: () => {
      pause()
      seekTo(0)
      props.onStopped()
    },
    next: () => next(true),
    previous,
    seekBy,
    seekTo,
    volumeBy: (d) => setVolume(volume() + d),
    setVolume,
    setRate: (r) => changeSpeed(Math.min(3, Math.max(0.25, r))),
    setRepeat: () => undefined,
    setShuffle: () => undefined,
    toggleMute: () => {
      props.onPrefs({ muted: !muted() })
      flash(muted() ? 'Sound on' : 'Muted')
    },
  }

  // --- subtitles ----------------------------------------------------------------------
  const applySubs = () => {
    const active = activeSub()
    const list = video.textTracks
    for (let i = 0; i < list.length; i++) {
      const t = list[i]
      if (t === undefined) continue
      const id = t.id !== '' ? t.id : `embedded-${i}`
      const on = active !== null && id === active
      t.mode = on ? 'showing' : 'disabled'
      if (on) positionCues(t)
    }
  }

  const positionCues = (track: TextTrack) => {
    const line = SUB_LINE[props.prefs.subPosition]
    const cues = track.cues
    if (cues === null) return
    for (const cue of Array.from(cues)) {
      if (cue instanceof VTTCue) {
        if (line === 'auto') {
          cue.snapToLines = true
          cue.line = 'auto'
        } else {
          cue.snapToLines = false
          cue.line = line
        }
      }
    }
  }

  const collectEmbedded = () => {
    const list = video.textTracks
    const found: SubTrack[] = []
    for (let i = 0; i < list.length; i++) {
      const t = list[i]
      if (t === undefined || t.kind === 'metadata' || t.kind === 'chapters') continue
      if (t.id.startsWith('file-')) continue
      found.push({
        id: t.id !== '' ? t.id : `embedded-${i}`,
        label: t.label || (t.language !== '' ? t.language : `Track ${found.length + 1}`),
        kind: 'embedded',
      })
    }
    setSubs((prev) => [...found, ...prev.filter((s) => s.kind === 'file')])
  }

  const addSubtitleFile = async (path: string, show: boolean) => {
    const it = item()
    try {
      const vtt = await subtitleVtt(path)
      const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
      const track: SubTrack = {
        id: `file-${subs().length}-${Date.now()}`,
        label: subtitleLabel(path, it?.path ?? ''),
        kind: 'file',
        path,
        url,
      }
      setSubs((prev) => [...prev, track])
      if (show) {
        setActiveSub(track.id)
        queueMicrotask(applySubs)
      }
    } catch (e) {
      toast(`Could not read ${path.slice(path.lastIndexOf('/') + 1)}: ${String(e)}`, {
        kind: 'danger',
      })
    }
  }

  const loadSubtitles = async () => {
    const picked = await openDialog({
      multiple: false,
      title: 'Load subtitles',
      filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'ass', 'ssa', 'sub'] }],
    })
    if (typeof picked === 'string') await addSubtitleFile(picked, true)
  }

  const cycleSubs = () => {
    const list = subs()
    if (list.length === 0) {
      flash('No subtitles')
      return
    }
    const cur = activeSub()
    const i = list.findIndex((s) => s.id === cur)
    const nextTrack = i + 1 >= list.length ? null : list[i + 1]
    setActiveSub(nextTrack?.id ?? null)
    applySubs()
    flash(nextTrack === null || nextTrack === undefined ? 'Subtitles off' : nextTrack.label)
  }

  // --- audio tracks -------------------------------------------------------------------
  const collectAudio = () => {
    const list = audioTracksOf(video)
    if (list === undefined) {
      setAudioTracks([])
      return
    }
    const out: AudioTrackLike[] = []
    // AudioTrackList is not iterable
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i]
      if (t !== undefined) out.push(t)
    }
    setAudioTracks(out)
    setActiveAudio(out.find((t) => t.enabled)?.id ?? out[0]?.id ?? null)
  }
  const chooseAudio = (id: string) => {
    const list = audioTracksOf(video)
    if (list === undefined) return
    // AudioTrackList is not iterable
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i]
      if (t !== undefined) t.enabled = t.id === id
    }
    setActiveAudio(id)
    const picked = audioTracks().find((t) => t.id === id)
    flash(picked === undefined ? 'Audio track' : audioLabel(picked, audioTracks().indexOf(picked)))
  }
  const audioLabel = (t: AudioTrackLike, i: number) =>
    t.label || (t.language !== '' ? t.language : `Audio ${i + 1}`)

  // --- errors -------------------------------------------------------------------------
  const explainError = async () => {
    const it = item()
    if (it === undefined) return
    const code = video.error?.code ?? null
    let streams = null
    if (!it.remote) {
      try {
        streams = await probeMedia(it.path)
      } catch {
        streams = null
      }
    }
    setError(decodeFailureMessage(it.name, streams, code))
    setPlaying(false)
    publish({ status: 'stopped' }, true)
  }

  // --- screenshot ---------------------------------------------------------------------
  const screenshot = async () => {
    const it = item()
    if (it === undefined || it.remote) {
      toast('Screenshots work for local files only')
      return
    }
    try {
      const saved = await screenshotFrame(it.path, video.currentTime)
      toast(`Saved ${saved.name}`, {
        kind: 'success',
        action: { label: 'Open', run: () => void launchWith(null, [saved.path]) },
      })
    } catch (e) {
      toast(`Could not save the frame: ${String(e)}`, { kind: 'danger' })
    }
  }

  // --- keys ---------------------------------------------------------------------------
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (menu() !== null) return
    poke()
    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        toggle()
        break
      case 'ArrowLeft':
        seekBy(-5)
        break
      case 'ArrowRight':
        seekBy(5)
        break
      case 'j':
      case 'J':
        seekBy(-10)
        break
      case 'l':
      case 'L':
        seekBy(10)
        break
      case 'ArrowUp':
        setVolume(volume() + 0.05)
        break
      case 'ArrowDown':
        setVolume(volume() - 0.05)
        break
      case 'm':
      case 'M':
        transport.toggleMute()
        break
      case 'f':
      case 'F':
        props.onFullscreen(!props.fullscreen)
        break
      case 'c':
      case 'C':
        cycleSubs()
        break
      case '[':
        changeSpeed(stepSpeed(speed(), -1))
        break
      case ']':
        changeSpeed(stepSpeed(speed(), 1))
        break
      case 'n':
      case 'N':
        next(true)
        break
      case 'p':
      case 'P':
        previous()
        break
      case ',':
        frameStep(-1)
        break
      case '.':
        frameStep(1)
        break
      case 's':
      case 'S':
        void screenshot()
        break
      case 'r':
      case 'R':
        setRotation((r) => (r + 90) % 360)
        break
      case 'Home':
        seekTo(0)
        break
      case 'End':
        seekTo(Math.max(0, duration() - 0.5))
        break
      case 'Escape':
        if (props.fullscreen) props.onFullscreen(false)
        else if (props.mini) props.onMini(false)
        else return
        break
      default:
        if (/^[0-9]$/.test(e.key) && duration() > 0) {
          seekTo((duration() * Number(e.key)) / 10)
          break
        }
        return
    }
    e.preventDefault()
  }

  onMount(() => {
    props.onTransport(transport)
    window.addEventListener('keydown', onKey)
    const observer = new ResizeObserver(() => {
      const r = stage.getBoundingClientRect()
      setStageSize({ w: r.width, h: r.height })
    })
    observer.observe(stage)
    const tracks = video.textTracks
    const onTracks = () => collectEmbedded()
    tracks.addEventListener('addtrack', onTracks)
    tracks.addEventListener('removetrack', onTracks)
    const audio = audioTracksOf(video)
    const onAudio = () => collectAudio()
    audio?.addEventListener('addtrack', onAudio)
    audio?.addEventListener('removetrack', onAudio)
    applyVolume()
    poke()
    onCleanup(() => {
      props.onTransport(null)
      window.removeEventListener('keydown', onKey)
      observer.disconnect()
      tracks.removeEventListener('addtrack', onTracks)
      tracks.removeEventListener('removetrack', onTracks)
      audio?.removeEventListener('addtrack', onAudio)
      audio?.removeEventListener('removetrack', onAudio)
      if (hideTimer !== null) clearTimeout(hideTimer)
      if (osdTimer !== null) clearTimeout(osdTimer)
      for (const s of subs()) if (s.url !== undefined) URL.revokeObjectURL(s.url)
      void inhibitIdle(false).catch(() => undefined)
      publish({ status: 'stopped' }, true)
    })
  })

  // a new file
  createEffect(
    on(src, (url) => {
      const it = item()
      setError(null)
      setResume(null)
      setTime(0)
      setDuration(0)
      setBuffered([])
      setSpeed(1)
      setRotation(0)
      for (const s of subs()) if (s.url !== undefined) URL.revokeObjectURL(s.url)
      setSubs([])
      setActiveSub(null)
      setAudioTracks([])
      resumeFor = it === undefined || it.remote ? null : it.path
      if (url === '') {
        video.removeAttribute('src')
        video.load()
        return
      }
      video.src = url
      video.playbackRate = 1
      video.load()
      if (it !== undefined && !it.remote) {
        void addRecent(it.path).catch(() => undefined)
        void subtitleFiles(it.path).then((files) => {
          if (item()?.path !== it.path) return
          files.forEach((f, i) => void addSubtitleFile(f, i === 0 && audioTracks().length === 0))
        })
      }
      publish(
        {
          metadata: {
            id: `${props.index}:${it?.path ?? ''}`,
            title: title(),
            url: it?.path ?? null,
            length: null,
          },
          canNext: canNext(),
          canPrevious: canPrevious(),
          position: 0,
        },
        true,
      )
    }),
  )

  createEffect(() => {
    applyVolume()
    publish({ volume: muted() ? 0 : volume() })
  })
  createEffect(on(() => props.prefs.subPosition, applySubs, { defer: true }))
  createEffect(() => {
    void inhibitIdle(playing()).catch(() => undefined)
  })
  createEffect(() => publish({ fullscreen: props.fullscreen }))
  createEffect(() => {
    if (!visible()) setMenu(null)
  })

  // --- seek bar maths -----------------------------------------------------------------
  const ratioAt = (clientX: number) => {
    const r = seekBar.getBoundingClientRect()
    return r.width === 0 ? 0 : Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }
  const played = () => (duration() > 0 ? (time() / duration()) * 100 : 0)

  // --- stage transform ----------------------------------------------------------------
  const videoStyle = (): JSX.CSSProperties => {
    const rotated = rotation() % 180 !== 0
    const { w, h } = stageSize()
    const fit: FitMode = props.prefs.fit
    const style: JSX.CSSProperties = {
      'object-fit': fit === 'cover' ? 'cover' : 'contain',
      transform: `rotate(${rotation()}deg)${fit === 'zoom' ? ' scale(1.5)' : ''}`,
    }
    if (rotated && w > 0 && h > 0) {
      style.width = `${h}px`
      style.height = `${w}px`
    }
    return style
  }

  const check = (on: boolean) => (on ? ('check' as const) : undefined)
  const menuItems = (): MenuEntry[] => {
    const m = menu()
    if (m === null) return []
    switch (m.kind) {
      case 'speed':
        return SPEEDS.map((s) => ({
          type: 'item',
          id: `speed-${s}`,
          label: formatSpeed(s),
          icon: check(Math.abs(s - speed()) < 1e-6),
          run: () => changeSpeed(s),
        }))
      case 'subs': {
        const list = subs()
        const sizes: SubSize[] = ['small', 'normal', 'large', 'huge']
        const positions: SubPosition[] = ['bottom', 'raised', 'top']
        return [
          {
            type: 'item',
            id: 'off',
            label: 'Off',
            icon: check(activeSub() === null),
            run: () => {
              setActiveSub(null)
              applySubs()
            },
          },
          ...list.map((s): MenuEntry => ({
            type: 'item',
            id: s.id,
            label: s.label,
            hint: s.kind === 'embedded' ? 'in the file' : undefined,
            icon: check(activeSub() === s.id),
            run: () => {
              setActiveSub(s.id)
              applySubs()
            },
          })),
          { type: 'separator' },
          {
            type: 'item',
            id: 'load',
            label: 'Load subtitles…',
            icon: 'folder-open',
            run: () => void loadSubtitles(),
          },
          {
            type: 'item',
            id: 'size',
            label: 'Size',
            items: sizes.map((s) => ({
              type: 'item',
              id: `size-${s}`,
              label: capital(s),
              icon: check(props.prefs.subSize === s),
              run: () => props.onPrefs({ subSize: s }),
            })),
          },
          {
            type: 'item',
            id: 'position',
            label: 'Position',
            items: positions.map((p) => ({
              type: 'item',
              id: `pos-${p}`,
              label: capital(p),
              icon: check(props.prefs.subPosition === p),
              run: () => props.onPrefs({ subPosition: p }),
            })),
          },
        ]
      }
      case 'audio':
        return audioTracks().length === 0
          ? [{ type: 'item', id: 'none', label: 'Only one audio track', disabled: true }]
          : audioTracks().map((t, i) => ({
              type: 'item',
              id: t.id,
              label: audioLabel(t, i),
              icon: check(activeAudio() === t.id),
              run: () => chooseAudio(t.id),
            }))
      case 'view':
        return [
          {
            type: 'item',
            id: 'fit',
            label: 'Fit',
            icon: check(props.prefs.fit === 'contain'),
            run: () => props.onPrefs({ fit: 'contain' }),
          },
          {
            type: 'item',
            id: 'fill',
            label: 'Fill',
            icon: check(props.prefs.fit === 'cover'),
            run: () => props.onPrefs({ fit: 'cover' }),
          },
          {
            type: 'item',
            id: 'zoom',
            label: 'Zoom 1.5×',
            icon: check(props.prefs.fit === 'zoom'),
            run: () => props.onPrefs({ fit: 'zoom' }),
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'rotate',
            label: 'Rotate',
            hint: 'R',
            icon: 'rotate-cw',
            run: () => setRotation((r) => (r + 90) % 360),
          },
          {
            type: 'item',
            id: 'mini',
            label: props.mini ? 'Leave mini player' : 'Mini player',
            icon: 'picture-in-picture-2',
            run: () => props.onMini(!props.mini),
          },
        ]
      case 'more':
        return [
          {
            type: 'item',
            id: 'files',
            label: 'Open files…',
            icon: 'folder-open',
            hint: 'Ctrl+O',
            run: () => props.onAddFiles(),
          },
          {
            type: 'item',
            id: 'folder',
            label: 'Open folder…',
            icon: 'folder',
            run: () => props.onAddFolder(),
          },
          {
            type: 'item',
            id: 'url',
            label: 'Open URL…',
            icon: 'link',
            hint: 'Ctrl+L',
            run: () => props.onOpenUrl(),
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'shot',
            label: 'Save this frame',
            icon: 'camera',
            hint: 'S',
            run: () => void screenshot(),
          },
          {
            type: 'item',
            id: 'audio',
            label: 'Audio track',
            icon: 'languages',
            items: menuItemsFor('audio'),
          },
        ]
    }
  }
  const menuItemsFor = (kind: 'audio'): MenuEntry[] => {
    if (kind === 'audio')
      return audioTracks().length === 0
        ? [{ type: 'item', id: 'none', label: 'Only one audio track', disabled: true }]
        : audioTracks().map((t, i) => ({
            type: 'item',
            id: t.id,
            label: audioLabel(t, i),
            icon: check(activeAudio() === t.id),
            run: () => chooseAudio(t.id),
          }))
    return []
  }
  const openMenu = (kind: NonNullable<ReturnType<typeof menu>>['kind'], e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ kind, at: { x: r.left, y: r.top - 4 } })
  }

  const timeLabel = () =>
    props.prefs.remainingTime
      ? formatClock(Math.max(0, duration() - time()), true)
      : formatClock(time())

  return (
    <div
      class="vp"
      classList={{
        'controls-hidden': !visible() && playing(),
        [`sub-${props.prefs.subSize}`]: true,
        mini: props.mini,
      }}
      onMouseMove={poke}
      onMouseLeave={() => {
        if (playing() && menu() === null) setVisible(false)
      }}
    >
      <div
        class="vp-stage"
        ref={stage}
        onClick={(e) => {
          if (e.target === video || e.target === stage) toggle()
        }}
        onDblClick={(e) => {
          if (e.target === video || e.target === stage) props.onFullscreen(!props.fullscreen)
        }}
        onWheel={(e) => {
          if (e.deltaY !== 0) setVolume(volume() + (e.deltaY < 0 ? 0.05 : -0.05))
        }}
      >
        <video
          ref={video}
          class="vp-video"
          crossorigin="anonymous"
          preload="auto"
          autoplay={props.autoplay}
          playsinline
          style={videoStyle()}
          onPlay={() => {
            setPlaying(true)
            publish({ status: 'playing', position: video.currentTime }, true)
            poke()
          }}
          onPause={() => {
            setPlaying(false)
            setVisible(true)
            publish({ status: 'paused', position: video.currentTime }, true)
          }}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onLoadedMetadata={() => {
            setDuration(Number.isFinite(video.duration) ? video.duration : 0)
            collectEmbedded()
            collectAudio()
            applyVolume()
            publish({
              metadata: {
                id: `${props.index}:${item()?.path ?? ''}`,
                title: title(),
                url: item()?.path ?? null,
                length: Number.isFinite(video.duration) ? video.duration : null,
              },
            })
            const path = resumeFor
            resumeFor = null
            const saved = path === null ? undefined : props.positions[path]
            if (saved !== undefined && saved.position < video.duration - 5) {
              video.currentTime = saved.position
              setResume(saved)
              setTimeout(() => setResume(null), 8000)
            }
          }}
          onDurationChange={() => {
            if (Number.isFinite(video.duration)) setDuration(video.duration)
          }}
          onTimeUpdate={() => {
            const t = video.currentTime
            setTime(t)
            const now = Date.now()
            if (now - lastSaved > 5000) {
              lastSaved = now
              const it = item()
              if (it !== undefined && !it.remote) props.onPosition(it.path, t, video.duration)
            }
            if (now - lastPublished > 1000) {
              lastPublished = now
              publish({ position: t })
            }
          }}
          onProgress={() => {
            const b = video.buffered
            const out: [number, number][] = []
            for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)])
            setBuffered(out)
          }}
          onEnded={() => {
            const it = item()
            if (it !== undefined && !it.remote)
              props.onPosition(it.path, video.duration, video.duration)
            next(false)
          }}
          onError={() => void explainError()}
          onRateChange={() => setSpeed(video.playbackRate)}
        >
          <For each={subs().filter((s) => s.kind === 'file')}>
            {(s) => <track id={s.id} kind="subtitles" label={s.label} src={s.url} />}
          </For>
        </video>

        <Show when={error()}>
          {(err) => (
            <div class="vp-error">
              <EmptyState icon="circle-alert" title={err().title} warning heading="h2">
                {err().detail}
                <Show when={err().suggestLibav}>
                  {' '}
                  On ewe it comes with the next update; until then install it with Komble or `sudo
                  pacman -S gst-libav`.
                </Show>
              </EmptyState>
              <div class="vp-error-actions">
                <Show when={!(item()?.remote ?? true)}>
                  <Button
                    kind="secondary"
                    icon="external-link"
                    onClick={() => {
                      const it = item()
                      if (it !== undefined) void launchWith(null, [it.path])
                    }}
                  >
                    Open with another app
                  </Button>
                </Show>
                <Show when={canNext()}>
                  <Button kind="primary" icon="skip-forward" onClick={() => next(true)}>
                    Next
                  </Button>
                </Show>
              </div>
            </div>
          )}
        </Show>

        <Show when={waiting() && error() === null}>
          <div class="vp-spinner" aria-label="Loading" />
        </Show>

        <Show when={osd()}>{(text) => <div class="vp-osd">{text()}</div>}</Show>

        <Show when={!playing() && error() === null && item() !== undefined && !waiting()}>
          <button class="vp-bigplay" aria-label="Play" onClick={toggle}>
            <Icon name="play" size={28} />
          </button>
        </Show>

        <Show when={resume()}>
          {(saved) => (
            <div class="vp-resume">
              <Icon name="clock" size={14} />
              <span>Continuing from {formatClock(saved().position)}</span>
              <Button
                small
                kind="ghost"
                onClick={() => {
                  seekTo(0)
                  setResume(null)
                }}
              >
                Start over
              </Button>
            </div>
          )}
        </Show>

        <div class="vp-top">
          <span class="vp-title" title={item()?.path}>
            {title()}
          </span>
          <Show when={props.queue.length > 1}>
            <span class="vp-pos">
              {props.index + 1} of {props.queue.length}
            </span>
          </Show>
        </div>

        <div
          class="vp-controls"
          onMouseEnter={() => setOverControls(true)}
          onMouseLeave={() => setOverControls(false)}
        >
          <div
            class="vp-seek"
            ref={seekBar}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={duration()}
            aria-valuenow={time()}
            tabindex="0"
            onPointerDown={(e) => {
              e.preventDefault()
              setScrubbing(true)
              seekBar.setPointerCapture(e.pointerId)
              seekTo(ratioAt(e.clientX) * duration())
            }}
            onPointerMove={(e) => {
              const ratio = ratioAt(e.clientX)
              setHover({ x: ratio * 100, time: ratio * duration() })
              if (scrubbing()) seekTo(ratio * duration())
            }}
            onPointerUp={(e) => {
              setScrubbing(false)
              seekBar.releasePointerCapture(e.pointerId)
            }}
            onPointerLeave={() => setHover(null)}
          >
            <div class="vp-seek-track">
              <For each={buffered()}>
                {([s, e]) => (
                  <span
                    class="vp-seek-buffered"
                    style={{
                      left: `${duration() > 0 ? (s / duration()) * 100 : 0}%`,
                      width: `${duration() > 0 ? ((e - s) / duration()) * 100 : 0}%`,
                    }}
                  />
                )}
              </For>
              <span class="vp-seek-played" style={{ width: `${played()}%` }} />
              <span class="vp-seek-thumb" style={{ left: `${played()}%` }} />
            </div>
            <Show when={hover()}>
              {(h) => (
                <span class="vp-seek-hover" style={{ left: `${h().x}%` }}>
                  {formatClock(h().time)}
                </span>
              )}
            </Show>
          </div>
          <div class="vp-row">
            <IconButton
              icon="skip-back"
              label="Previous (P)"
              disabled={!canPrevious()}
              onClick={previous}
            />
            <IconButton icon="rewind" label="Back 10 s (J)" onClick={() => seekBy(-10)} />
            <button class="vp-play" aria-label={playing() ? 'Pause' : 'Play'} onClick={toggle}>
              <Icon name={playing() ? 'pause' : 'play'} size={20} />
            </button>
            <IconButton icon="fast-forward" label="Forward 10 s (L)" onClick={() => seekBy(10)} />
            <IconButton
              icon="skip-forward"
              label="Next (N)"
              disabled={!canNext()}
              onClick={() => next(true)}
            />
            <button
              class="vp-time"
              title="Switch between elapsed and remaining time"
              onClick={() => props.onPrefs({ remainingTime: !props.prefs.remainingTime })}
            >
              {timeLabel()} <span class="vp-time-sep">/</span> {formatClock(duration())}
            </button>
            <span class="toolbar-spacer" />
            <div class="vp-volume">
              <IconButton
                icon={
                  muted() || volume() === 0 ? 'volume-x' : volume() < 0.5 ? 'volume-1' : 'volume-2'
                }
                label={muted() ? 'Unmute (M)' : 'Mute (M)'}
                onClick={() => transport.toggleMute()}
              />
              <input
                type="range"
                class="slider vp-volume-slider"
                classList={{ boosted: volume() > 1 }}
                min="0"
                max={MAX_VOLUME}
                step="0.01"
                value={muted() ? 0 : volume()}
                aria-label="Volume"
                style={{ '--slider-fill': `${((muted() ? 0 : volume()) / MAX_VOLUME) * 100}%` }}
                onInput={(e) => setVolume(Number(e.currentTarget.value))}
              />
              <span class="vp-volume-label">{Math.round((muted() ? 0 : volume()) * 100)} %</span>
            </div>
            <button
              class="vp-chip"
              aria-label="Speed"
              title="Speed ([ ])"
              onClick={(e) => openMenu('speed', e)}
            >
              <Icon name="gauge" size={14} /> {formatSpeed(speed())}
            </button>
            <IconButton
              icon="captions"
              label="Subtitles (C)"
              active={activeSub() !== null}
              onClick={(e) => openMenu('subs', e)}
            />
            <Show when={audioTracks().length > 1}>
              <IconButton
                icon="languages"
                label="Audio track"
                onClick={(e) => openMenu('audio', e)}
              />
            </Show>
            <IconButton
              icon="scan"
              label="Fit, zoom, rotate"
              onClick={(e) => openMenu('view', e)}
            />
            <IconButton
              icon="list-music"
              label="Playlist"
              active={props.prefs.panel}
              onClick={() => props.onPrefs({ panel: !props.prefs.panel })}
            />
            <IconButton icon="ellipsis" label="More" onClick={(e) => openMenu('more', e)} />
            <IconButton
              icon={props.fullscreen ? 'minimize' : 'maximize'}
              label={props.fullscreen ? 'Leave fullscreen (F)' : 'Fullscreen (F)'}
              onClick={() => props.onFullscreen(!props.fullscreen)}
            />
          </div>
          <Show when={props.mini}>
            <div class="vp-mini-row">
              <Segmented
                small
                value="mini"
                label="Window"
                options={[
                  { value: 'mini', label: 'Mini' },
                  { value: 'full', label: 'Window' },
                ]}
                onChange={(v) => props.onMini(v === 'mini')}
              />
            </div>
          </Show>
        </div>
      </div>

      <Show when={props.prefs.panel && !props.mini}>
        <Playlist
          queue={props.queue}
          index={props.index}
          folder={props.folder}
          onPlay={(i) => props.onIndex(i)}
          onQueue={(q, i) => props.onQueue(q, i)}
          onAddFolder={() => {
            const missing = props.folder.filter((f) => !props.queue.some((q) => q.path === f.path))
            props.onQueue([...props.queue, ...missing], props.index)
          }}
          onAddFiles={() => props.onAddFiles()}
          onClose={() => props.onPrefs({ panel: false })}
        />
      </Show>

      <Show when={menu()}>
        {(m) => <Menu items={menuItems()} at={m().at} onClose={() => setMenu(null)} />}
      </Show>
    </div>
  )
}
