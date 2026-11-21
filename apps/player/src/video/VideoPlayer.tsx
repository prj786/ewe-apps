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
  LINK_TTL_MS,
  MAX_VOLUME,
  SPEEDS,
  clampVolume,
  codecWords,
  decodeFailureMessage,
  directLink,
  failedLink,
  formatClock,
  formatSpeed,
  isDirectMediaUrl,
  isWebUrl,
  itemTitle,
  languageBase,
  linkHost,
  nativeLanguageName,
  nextIndex,
  preferredTrack,
  previousIndex,
  rawUrl,
  stepSpeed,
  subtitleLabel,
  subtitleLanguage,
  systemLanguage,
  trackLabel,
  wantedLanguage,
  wantsSubtitles,
  type FailureAction,
  type LanguagePreference,
  type MediaItem,
  type MediaServer,
  type MediaSupport,
  type PlayFailure,
  type ResolvedLink,
  type SavedPosition,
} from '@ewe/shared'
import { TEXT_ENCODINGS, encodingLabel, encodingShort, isEncoding } from '@ewe/shared'
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  Segmented,
  addRecent,
  toast,
  type IconName,
  type MenuEntry,
} from '@ewe/ui'
import {
  inhibitIdle,
  launchWith,
  mediaSupport,
  openInBrowser,
  openInMpv,
  probeMedia,
  resolveLink,
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
  /** what a link turned out to be (its title, picture, length) for the queue */
  onItem(path: string, patch: Partial<MediaItem>): void
  /** a link that was a playlist: these items take its place */
  onExpand(path: string, items: MediaItem[]): void
  onAddFiles(): void
  onAddFolder(): void
  onOpenUrl(): void
  onTransport(transport: Transport | null): void
  onStopped(): void
  /** screenshot hook: controls | subs | audio-menu | playlist | mini */
  scene: string | null
}

interface SubTrack {
  id: string
  label: string
  kind: 'embedded' | 'file'
  /** base language code, when the track or the file name says */
  language: string | null
  /** file tracks: the source path (for the menu) and the blob URL of its VTT */
  path?: string
  url?: string
  /** file tracks: the encoding it was read in, and whether the person chose it */
  encoding?: string
  chosen?: boolean
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
/** a link that loaded nothing in this long is given up on (asked again once, then the page) */
const STALL_MS = 20_000
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
  const remote = () => item()?.remote === true

  // --- links: a web page becomes a stream through the core (yt-dlp) -------------------
  const [support, setSupport] = createSignal<MediaSupport | null>(null)
  const [link, setLink] = createSignal<{ path: string; link: ResolvedLink } | null>(null)
  /** the link being asked about ("Getting the video…") */
  const [resolving, setResolving] = createSignal<string | null>(null)
  const linkCache = new Map<string, { link: ResolvedLink; at: number }>()
  /** a stream that failed is asked for again once (its URL may have expired) */
  let retriedFor: string | null = null
  const currentLink = (): ResolvedLink | null => {
    const it = item()
    const r = link()
    return it !== undefined && it.remote && r !== null && r.path === it.path ? r.link : null
  }
  const remotePath = createMemo(() => {
    const it = item()
    return it?.remote === true ? it.path : null
  })

  const src = createMemo(() => {
    const it = item()
    if (it === undefined) return ''
    if (!it.remote) return rawUrl(props.server, it.path)
    const r = currentLink()
    return r !== null && (r.kind === 'direct' || r.kind === 'stream') ? r.url : ''
  })
  const title = () => {
    const it = item()
    return it === undefined ? '' : itemTitle(it)
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
  const [error, setError] = createSignal<PlayFailure | null>(null)
  /** ffprobe is looking at what failed (the error page follows) */
  const [explaining, setExplaining] = createSignal(false)
  const [osd, setOsd] = createSignal<string | null>(null)
  const [resume, setResume] = createSignal<SavedPosition | null>(null)
  /** sound plays but there is no picture: the video codec is missing */
  const [noPicture, setNoPicture] = createSignal<string | null>(null)
  let pictureTimer: ReturnType<typeof setTimeout> | null = null
  type MenuKind = 'speed' | 'subs' | 'audio' | 'view' | 'more' | 'encoding'
  const [menu, setMenu] = createSignal<{
    kind: MenuKind
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
      if (props.scene !== null) return
      if (playing() && !overControls() && menu() === null && !scrubbing()) setVisible(false)
    }, HIDE_AFTER)
  }

  // --- volume: the element up to 100 %, a gain node above that -------------------------
  // Only for the loopback server's files: a link plays without CORS (CDNs send no
  // Access-Control-Allow-Origin and a crossorigin <video> refuses them), and Web Audio
  // turns a cross-origin source into silence — links stop at 100 %.
  const applyVolume = () => {
    const v = muted() ? 0 : volume()
    if (!remote() && (v > 1 || gain !== null)) {
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

  // --- the element: a fresh one when a link follows a boosted file -------------------
  // once Web Audio captured an element it plays only through the gain node, which would be
  // silent for a link; a new <video> is the only way back to the plain output
  const [element, setElement] = createSignal(0)
  let unbindVideo: (() => void) | null = null
  const bindVideo = (el: HTMLVideoElement) => {
    unbindVideo?.()
    const tracks = el.textTracks
    const onTracks = () => collectEmbedded()
    tracks.addEventListener('addtrack', onTracks)
    tracks.addEventListener('removetrack', onTracks)
    // WebKit's own automatic caption selection runs when tracks arrive and may flip a
    // track we turned on back off: whatever changed a mode, ours is the one that counts
    const onModes = () => applySubs()
    tracks.addEventListener('change', onModes)
    const audio = audioTracksOf(el)
    const onAudio = () => collectAudio()
    audio?.addEventListener('addtrack', onAudio)
    audio?.addEventListener('removetrack', onAudio)
    unbindVideo = () => {
      tracks.removeEventListener('addtrack', onTracks)
      tracks.removeEventListener('removetrack', onTracks)
      tracks.removeEventListener('change', onModes)
      audio?.removeEventListener('addtrack', onAudio)
      audio?.removeEventListener('removetrack', onAudio)
    }
  }
  /** true when the element had to be replaced (the caller waits for the new one) */
  const freshElementForLink = (): boolean => {
    if (!remote() || gain === null) return false
    gain.disconnect()
    gain = null
    video.pause()
    video.removeAttribute('src')
    video.load()
    setElement((n) => n + 1)
    return true
  }

  // --- languages ------------------------------------------------------------------------
  const system = systemLanguage(
    navigator.languages.length > 0 ? navigator.languages : [navigator.language],
  )
  /** the user chose a track by hand for this item: no more automatic picks */
  let pickedSub = false
  let pickedAudio = false
  const spokenLanguage = (): string | null => {
    const list = audioTracks()
    const on = list.find((t) => t.id === activeAudio()) ?? list[0]
    return on === undefined ? null : languageBase(on.language)
  }
  const autoSubs = () => {
    if (pickedSub) return
    const wanted = wantedLanguage(props.prefs.subtitleLanguage, system)
    if (!wantsSubtitles(wanted, spokenLanguage())) {
      if (activeSub() !== null) {
        setActiveSub(null)
        applySubs()
      }
      return
    }
    const list = subs()
    // in the wanted language, else a sidecar that names no language (Movie.srt is the
    // film's own subtitles — what mpv shows too)
    const pick =
      preferredTrack(list, (t) => t.language, wanted) ??
      list.find((t) => t.kind === 'file' && t.language === null)
    if (pick !== undefined && pick.id !== activeSub()) {
      setActiveSub(pick.id)
      applySubs()
    }
  }
  const autoAudio = () => {
    if (pickedAudio) return
    const list = audioTracks()
    if (list.length < 2) return
    const pick = preferredTrack(
      list,
      (t) => t.language,
      wantedLanguage(props.prefs.audioLanguage, system),
    )
    if (pick !== undefined && pick.id !== activeAudio()) chooseAudio(pick.id, true)
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
      const mode = on ? 'showing' : 'disabled'
      // only real changes: a mode write fires `change`, which comes back here
      if (t.mode !== mode) t.mode = mode
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
        label: trackLabel({ language: t.language, label: t.label }, found.length, 'Subtitles'),
        kind: 'embedded',
        language: languageBase(t.language),
      })
    }
    setSubs((prev) => [...found, ...prev.filter((s) => s.kind === 'file')])
    autoSubs()
  }

  const addSubtitleFile = async (path: string, show: boolean) => {
    const it = item()
    try {
      const sub = await subtitleVtt(path)
      if (item()?.path !== it?.path) return
      const url = URL.createObjectURL(new Blob([sub.vtt], { type: 'text/vtt' }))
      const track: SubTrack = {
        id: `file-${subs().length}-${Date.now()}`,
        label: subtitleLabel(path, it?.path ?? ''),
        kind: 'file',
        language: subtitleLanguage(path, it?.path ?? ''),
        path,
        url,
        encoding: sub.encoding,
      }
      setSubs((prev) => [...prev, track])
      if (show) {
        pickedSub = true
        setActiveSub(track.id)
        queueMicrotask(applySubs)
      } else queueMicrotask(autoSubs)
    } catch (e) {
      toast(`Could not read ${path.slice(path.lastIndexOf('/') + 1)}: ${String(e)}`, {
        kind: 'danger',
      })
    }
  }

  /** Read the active subtitle file again in another encoding (null: detect). */
  const rereadSubtitle = async (encoding: string | null) => {
    const old = subs().find((s) => s.id === activeSub())
    if (old?.kind !== 'file' || old.path === undefined) return
    const path = old.path
    try {
      const sub = await subtitleVtt(path, encoding)
      const track: SubTrack = {
        ...old,
        // a new <track> element: WebKit does not reload one whose src changes
        id: `file-${subs().length}-${Date.now()}`,
        url: URL.createObjectURL(new Blob([sub.vtt], { type: 'text/vtt' })),
        encoding: sub.encoding,
        chosen: encoding !== null,
      }
      setSubs((prev) => prev.map((s) => (s.id === old.id ? track : s)))
      if (old.url !== undefined) URL.revokeObjectURL(old.url)
      setActiveSub(track.id)
      queueMicrotask(applySubs)
      flash(encodingLabel(sub.encoding))
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
    pickedSub = true
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
    autoAudio()
    autoSubs()
  }
  const chooseAudio = (id: string, quiet = false) => {
    const list = audioTracksOf(video)
    if (list === undefined) return
    // AudioTrackList is not iterable
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i]
      if (t !== undefined) t.enabled = t.id === id
    }
    setActiveAudio(id)
    if (quiet) return
    const picked = audioTracks().find((t) => t.id === id)
    flash(picked === undefined ? 'Audio track' : audioLabel(picked, audioTracks().indexOf(picked)))
  }
  const audioLabel = (t: AudioTrackLike, i: number) =>
    trackLabel({ language: t.language, label: t.label }, i, 'Audio')

  // --- links ----------------------------------------------------------------------------
  const useLink = (url: string, r: ResolvedLink) => {
    if (r.kind === 'playlist' && r.entries.length > 0) {
      props.onExpand(
        url,
        r.entries.map((e) => ({
          path: e.url,
          name: linkHost(e.url),
          kind: 'video' as const,
          remote: true,
          title: e.title ?? undefined,
          duration: e.duration ?? undefined,
        })),
      )
      return
    }
    setLink({ path: url, link: r })
    const patch: Partial<MediaItem> = {}
    if (r.title !== null) patch.title = r.title
    if (r.thumbnail !== null) patch.thumbnail = r.thumbnail
    if (r.duration !== null) patch.duration = r.duration
    if (Object.keys(patch).length > 0) props.onItem(url, patch)
  }

  const resolve = async (url: string, fresh: boolean) => {
    const cached = linkCache.get(url)
    if (!fresh && cached !== undefined && Date.now() - cached.at < LINK_TTL_MS) {
      useLink(url, cached.link)
      return
    }
    setLink(null)
    if (isDirectMediaUrl(url)) {
      useLink(url, directLink(url, /\.m3u8($|\?)/i.test(url) ? 'hls' : 'file'))
      return
    }
    setResolving(url)
    let r: ResolvedLink
    try {
      r = await resolveLink(url)
    } catch (e) {
      r = failedLink(url, String(e))
    }
    if (resolving() === url) setResolving(null)
    if (r.kind !== 'failed') linkCache.set(url, { link: r, at: Date.now() })
    if (item()?.path !== url) return
    useLink(url, r)
  }

  const retry = () => {
    const it = item()
    if (it === undefined) return
    setError(null)
    retriedFor = null
    if (it.remote) {
      linkCache.delete(it.path)
      void resolve(it.path, true)
    } else video.load()
  }

  /** the page behind a link that failed (a page of its own, or a stream yt-dlp found) */
  const linkFailure = createMemo((): PlayFailure | null => {
    const r = currentLink()
    if (r === null || (r.kind !== 'page' && r.kind !== 'failed')) return null
    return decodeFailureMessage({
      name: title(),
      remote: true,
      streams: null,
      mediaErrorCode: null,
      support: support(),
      link: r,
    })
  })
  const failure = () => error() ?? linkFailure()

  // --- a stream that never starts -------------------------------------------------------
  // a stalled first fragment (seen once with YouTube's HLS) leaves the element loading
  // forever with no error: after STALL_MS with nothing loaded, treat it as a broken load
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const clearStall = () => {
    if (stallTimer !== null) clearTimeout(stallTimer)
    stallTimer = null
  }
  const watchStall = () => {
    clearStall()
    stallTimer = setTimeout(() => {
      stallTimer = null
      if (video.readyState === 0 && remote() && failure() === null) void explainError(true)
    }, STALL_MS)
  }

  // --- errors -------------------------------------------------------------------------
  /** `stalled`: a link loaded nothing for STALL_MS (no error event ever comes) */
  const explainError = async (stalled = false) => {
    clearStall()
    const it = item()
    if (it === undefined || src() === '') return
    const code = stalled ? 2 : (video.error?.code ?? null)
    const r = currentLink()
    // a stream from yt-dlp expires (googlevideo after ~6 h): ask for it again, once
    if (it.remote && r?.kind === 'stream' && retriedFor !== it.path) {
      retriedFor = it.path
      linkCache.delete(it.path)
      void resolve(it.path, true)
      return
    }
    setPlaying(false)
    publish({ status: 'stopped' }, true)
    if (stalled) {
      video.removeAttribute('src')
      video.load()
    }
    setExplaining(true)
    const streams = await probeMedia(it.remote ? (r?.url ?? it.path) : it.path).catch(() => null)
    const known = support() ?? (await mediaSupport())
    setExplaining(false)
    if (item()?.path !== it.path) return
    setError(
      decodeFailureMessage({
        name: it.remote ? title() : it.name,
        remote: it.remote,
        streams,
        mediaErrorCode: code,
        support: known,
        link: r,
      }),
    )
  }

  const runAction = (action: FailureAction) => {
    const it = item()
    if (it === undefined) return
    const fail = (what: string) => (e: unknown) =>
      toast(`Could not open ${what}: ${String(e)}`, { kind: 'danger' })
    switch (action) {
      case 'open-with':
        void launchWith(null, [it.path]).catch(fail('it'))
        break
      case 'browser':
        void openInBrowser(it.path).catch(fail('ewe Browser'))
        break
      case 'mpv':
        void openInMpv(it.path)
          .then(() => pause())
          .catch(fail('mpv'))
        break
      case 'retry':
        retry()
        break
    }
  }
  const actionButton = (action: FailureAction): { label: string; icon: IconName } | null => {
    const it = item()
    if (it === undefined) return null
    switch (action) {
      case 'open-with':
        return it.remote ? null : { label: 'Open with another app', icon: 'external-link' }
      case 'browser':
        return isWebUrl(it.path) ? { label: 'Open in ewe Browser', icon: 'globe' } : null
      case 'mpv':
        return support()?.mpv === true ? { label: 'Open in mpv', icon: 'film' } : null
      case 'retry':
        return { label: 'Try again', icon: 'rotate-cw' }
    }
  }
  const failureActions = () =>
    (failure()?.actions ?? []).flatMap((a) => {
      const b = actionButton(a)
      return b === null ? [] : [{ action: a, ...b }]
    })

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

  // --- no picture? ----------------------------------------------------------------------
  const checkPicture = () => {
    if (pictureTimer !== null) clearTimeout(pictureTimer)
    pictureTimer = setTimeout(() => {
      pictureTimer = null
      const it = item()
      if (it === undefined || it.remote || video.paused || video.videoWidth > 0) return
      void Promise.all([probeMedia(it.path), mediaSupport()]).then(([streams, known]) => {
        if (item()?.path !== it.path || video.videoWidth > 0) return
        const v = streams.find((s) => s.kind === 'video')
        if (v === undefined) return
        const words = codecWords(v.codec)
        setNoPicture(
          `No picture: the video is ${words.label}${
            words.needsLibav && !known.libav
              ? ', which needs gst-libav (not installed)'
              : ' and its decoder refused it'
          }. Playing the sound only.`,
        )
      })
    }, 1500)
  }

  // --- screenshot hook ----------------------------------------------------------------
  const applyScene = (scene: string) => {
    const at = { x: Math.round(stageSize().w * 0.7), y: Math.round(stageSize().h - 56) }
    if (scene === 'subs' || scene === 'subs-encoding')
      setTimeout(() => {
        const srt = subs().find((s) => s.path?.toLowerCase().endsWith('.srt'))
        if (srt !== undefined) {
          pickedSub = true
          setActiveSub(srt.id)
          applySubs()
        }
      }, 1200)
    if (scene === 'audio-menu') setTimeout(() => setMenu({ kind: 'audio', at }), 400)
    else if (scene === 'subs-menu') setTimeout(() => setMenu({ kind: 'subs', at }), 400)
    else if (scene === 'subs-encoding') setTimeout(() => setMenu({ kind: 'encoding', at }), 1600)
    else if (scene === 'playlist') props.onPrefs({ panel: true })
    else if (scene === 'mini') props.onMini(true)
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
    void mediaSupport().then(setSupport)
    applyVolume()
    poke()
    onCleanup(() => {
      props.onTransport(null)
      window.removeEventListener('keydown', onKey)
      observer.disconnect()
      unbindVideo?.()
      if (hideTimer !== null) clearTimeout(hideTimer)
      if (osdTimer !== null) clearTimeout(osdTimer)
      if (pictureTimer !== null) clearTimeout(pictureTimer)
      clearStall()
      for (const s of subs()) if (s.url !== undefined) URL.revokeObjectURL(s.url)
      void inhibitIdle(false).catch(() => undefined)
      publish({ status: 'stopped' }, true)
    })
  })

  const publishMeta = () => {
    const it = item()
    const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null
    publish({
      metadata: {
        id: `${props.index}:${it?.path ?? ''}`,
        title: title(),
        url: it?.path ?? null,
        length: d ?? it?.duration ?? null,
        artUrl: it?.remote === true ? (it.thumbnail ?? null) : null,
      },
    })
  }

  // a link: ask the core what to play (a web page through yt-dlp) when it becomes current
  createEffect(
    on(remotePath, (url) => {
      retriedFor = null
      if (url === null) {
        setResolving(null)
        return
      }
      void resolve(url, false)
    }),
  )
  // the site's title arrives after the link was opened
  createEffect(on(title, () => publishMeta(), { defer: true }))

  // a new file
  createEffect(
    on([src, element], ([url]) => {
      const it = item()
      if (freshElementForLink()) return
      clearStall()
      setError(null)
      setExplaining(false)
      pickedSub = false
      pickedAudio = false
      setResume(null)
      setNoPicture(null)
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
      // setting src starts the load; an extra load() would abort and restart the fetch
      video.src = url
      video.playbackRate = 1
      if (it?.remote === true) watchStall()
      if (it !== undefined && !it.remote) {
        void addRecent(it.path).catch(() => undefined)
        void subtitleFiles(it.path).then((files) => {
          if (item()?.path !== it.path) return
          // which one shows (if any) is the preferred-language rule's call (autoSubs)
          files.forEach((f) => void addSubtitleFile(f, false))
        })
      }
      publish({ canNext: canNext(), canPrevious: canPrevious(), position: 0 }, true)
      publishMeta()
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

  // a narrow bar (a small window, or the playlist beside the video) keeps the transport,
  // volume and seek bar; the time, speed, picture and audio buttons move into ⋯ (the mini
  // window has its own rules in video.css and keeps them)
  const narrowBar = () => !props.mini && stageSize().w > 0 && stageSize().w < 560

  const check = (on: boolean) => (on ? ('check' as const) : undefined)
  /** "Preferred language": automatic (the system's), off (subtitles), the file's languages */
  const languageChoices = (
    current: LanguagePreference,
    found: (string | null)[],
    allowOff: boolean,
    apply: (value: LanguagePreference) => void,
  ): MenuEntry[] => {
    const codes = [...new Set([...found, current].map((c) => languageBase(c)))].filter(
      (c): c is string => c !== null && c !== system,
    )
    const entry = (value: LanguagePreference, label: string): MenuEntry => ({
      type: 'item',
      id: `lang-${value}`,
      label,
      icon: check(current === value),
      run: () => apply(value),
    })
    return [
      entry('auto', `${nativeLanguageName(system) ?? system} (system)`),
      ...(allowOff ? [entry('off', 'Off')] : []),
      ...codes
        .map((c) => ({ c, name: nativeLanguageName(c) ?? c }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ c, name }) => entry(c, name)),
    ]
  }
  const pickAudioLanguage = (v: LanguagePreference) => {
    props.onPrefs({ audioLanguage: v })
    pickedAudio = false
    queueMicrotask(autoAudio)
  }
  const pickSubtitleLanguage = (v: LanguagePreference) => {
    props.onPrefs({ subtitleLanguage: v })
    pickedSub = false
    queueMicrotask(autoSubs)
  }
  const audioItems = (): MenuEntry[] => [
    ...(audioTracks().length === 0
      ? [{ type: 'item', id: 'none', label: 'Only one audio track', disabled: true } as const]
      : audioTracks().map((t, i): MenuEntry => ({
          type: 'item',
          id: t.id,
          label: audioLabel(t, i),
          icon: check(activeAudio() === t.id),
          run: () => {
            pickedAudio = true
            chooseAudio(t.id)
          },
        }))),
    { type: 'separator' },
    {
      type: 'item',
      id: 'audio-language',
      label: 'Preferred language',
      icon: 'languages',
      items: languageChoices(
        props.prefs.audioLanguage,
        audioTracks().map((t) => t.language),
        false,
        pickAudioLanguage,
      ),
    },
  ]

  /** the subtitle file showing now (embedded tracks are decoded by GStreamer) */
  const activeFile = () => subs().find((s) => s.id === activeSub() && s.kind === 'file')
  const encodingItems = (): MenuEntry[] => {
    const file = activeFile()
    return [
      {
        type: 'item',
        id: 'enc-auto',
        label: 'Automatic',
        hint: file?.chosen === true ? undefined : encodingShort(file?.encoding ?? 'UTF-8'),
        icon: check(file?.chosen !== true),
        run: () => void rereadSubtitle(null),
      },
      { type: 'separator' },
      ...TEXT_ENCODINGS.map((e): MenuEntry => ({
        type: 'item',
        id: `enc-${e.name}`,
        label: e.label,
        icon: check(file?.chosen === true && isEncoding(file.encoding, e.name)),
        run: () => void rereadSubtitle(e.name),
      })),
    ]
  }
  const menuItems = (): MenuEntry[] => {
    const m = menu()
    return m === null ? [] : itemsFor(m.kind)
  }
  const itemsFor = (kind: MenuKind): MenuEntry[] => {
    switch (kind) {
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
              pickedSub = true
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
              pickedSub = true
              setActiveSub(s.id)
              applySubs()
            },
          })),
          { type: 'separator' },
          {
            type: 'item',
            id: 'sub-language',
            label: 'Preferred language',
            icon: 'languages',
            items: languageChoices(
              props.prefs.subtitleLanguage,
              list.map((s) => s.language),
              true,
              pickSubtitleLanguage,
            ),
          },
          {
            type: 'item',
            id: 'load',
            label: 'Load subtitles…',
            icon: 'folder-open',
            run: () => void loadSubtitles(),
          },
          {
            type: 'item',
            id: 'encoding',
            label: 'Subtitle encoding',
            hint: activeFile() ? encodingShort(activeFile()?.encoding ?? 'UTF-8') : undefined,
            disabled: activeFile() === undefined,
            items: encodingItems(),
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
      case 'encoding':
        return encodingItems()
      case 'audio':
        return audioItems()
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
          ...(narrowBar()
            ? ([
                {
                  type: 'item',
                  id: 'speed',
                  label: `Speed · ${formatSpeed(speed())}`,
                  icon: 'gauge',
                  items: itemsFor('speed'),
                },
                {
                  type: 'item',
                  id: 'view',
                  label: 'Fit, zoom, rotate',
                  icon: 'scan',
                  items: itemsFor('view'),
                },
                { type: 'separator' },
              ] satisfies MenuEntry[])
            : []),
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
            items: audioItems(),
          },
        ]
    }
  }
  const openMenu = (kind: MenuKind, e: MouseEvent) => {
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
        'cue-bottom': props.prefs.subPosition === 'bottom',
        mini: props.mini,
        narrow: narrowBar(),
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
        <For each={[element()]}>
          {() => (
            <video
              ref={(el) => {
                video = el
                bindVideo(el)
              }}
              class="vp-video"
              // the loopback server answers CORS (Web Audio, frame grabs); links' CDNs do not
              crossorigin={remote() ? undefined : 'anonymous'}
              preload="auto"
              autoplay={props.autoplay}
              playsinline
              style={videoStyle()}
              onPlay={() => {
                setPlaying(true)
                publish({ status: 'playing', position: video.currentTime }, true)
                poke()
                checkPicture()
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
                clearStall()
                setDuration(Number.isFinite(video.duration) ? video.duration : 0)
                collectEmbedded()
                collectAudio()
                applyVolume()
                publishMeta()
                const path = resumeFor
                resumeFor = null
                if (props.scene !== null) applyScene(props.scene)
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
          )}
        </For>

        <Show when={failure()}>
          {(err) => (
            <div class="vp-error">
              <EmptyState
                icon={
                  err().kind === 'page' || err().kind === 'needs-ytdlp' ? 'globe' : 'circle-alert'
                }
                title={err().title}
                warning
                heading="h2"
              >
                {err().detail}
              </EmptyState>
              <div class="vp-error-actions">
                <For each={failureActions()}>
                  {(a, i) => (
                    <Button
                      kind={i() === 0 && !canNext() ? 'primary' : 'secondary'}
                      icon={a.icon}
                      onClick={() => runAction(a.action)}
                    >
                      {a.label}
                    </Button>
                  )}
                </For>
                <Show when={canNext()}>
                  <Button kind="primary" icon="skip-forward" onClick={() => next(true)}>
                    Next
                  </Button>
                </Show>
              </div>
            </div>
          )}
        </Show>

        <Show when={resolving() !== null && failure() === null}>
          <div class="vp-getting" role="status">
            <div class="vp-getting-spin" aria-hidden="true" />
            <strong>Getting the video…</strong>
            <span>{linkHost(resolving() ?? '')}</span>
          </div>
        </Show>

        <Show when={(waiting() || explaining()) && failure() === null && resolving() === null}>
          <div class="vp-spinner" aria-label="Loading" />
        </Show>

        <Show when={osd()}>{(text) => <div class="vp-osd">{text()}</div>}</Show>

        <Show
          when={
            !playing() &&
            failure() === null &&
            item() !== undefined &&
            !waiting() &&
            !explaining() &&
            resolving() === null
          }
        >
          <button class="vp-bigplay" aria-label="Play" onClick={toggle}>
            <Icon name="play" size={28} />
          </button>
        </Show>

        <Show when={noPicture()}>
          {(text) => (
            <div class="vp-resume vp-notice">
              <Icon name="circle-alert" size={14} />
              <span>{text()}</span>
              <Button small kind="ghost" onClick={() => setNoPicture(null)}>
                OK
              </Button>
            </div>
          )}
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
          <span class="vp-title" dir="auto" title={item()?.path}>
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
                class="vp-audio-btn"
                onClick={(e) => openMenu('audio', e)}
              />
            </Show>
            <IconButton
              icon="scan"
              label="Fit, zoom, rotate"
              class="vp-view-btn"
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
