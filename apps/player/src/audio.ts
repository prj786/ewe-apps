// The music engine: two <audio> elements so the next track is already buffered when the
// current one ends (gapless enough), plus a Web Audio gain for volume above 100 %.

export interface EngineEvents {
  onPlay(): void
  onPause(): void
  onTime(seconds: number): void
  onDuration(seconds: number): void
  onEnded(): void
  onError(code: number | null): void
}

function makeElement(): HTMLAudioElement {
  const el = new Audio()
  el.preload = 'auto'
  el.crossOrigin = 'anonymous'
  return el
}

export class AudioEngine {
  private a = makeElement()
  private b = makeElement()
  private current: HTMLAudioElement
  private standby: HTMLAudioElement
  private standbyUrl = ''
  private volumeValue = 1
  private rateValue = 1
  private context: AudioContext | null = null
  private gains = new Map<HTMLAudioElement, GainNode>()

  constructor(private readonly events: EngineEvents) {
    this.current = this.a
    this.standby = this.b
    this.bind(this.a)
    this.bind(this.b)
  }

  private bind(el: HTMLAudioElement): void {
    el.addEventListener('play', () => {
      if (el === this.current) this.events.onPlay()
    })
    el.addEventListener('pause', () => {
      if (el === this.current) this.events.onPause()
    })
    el.addEventListener('timeupdate', () => {
      if (el === this.current) this.events.onTime(el.currentTime)
    })
    el.addEventListener('durationchange', () => {
      if (el === this.current && Number.isFinite(el.duration)) this.events.onDuration(el.duration)
    })
    el.addEventListener('ended', () => {
      if (el === this.current) this.events.onEnded()
    })
    el.addEventListener('error', () => {
      if (el === this.current) this.events.onError(el.error?.code ?? null)
    })
  }

  get element(): HTMLAudioElement {
    return this.current
  }

  get paused(): boolean {
    return this.current.paused
  }

  get currentTime(): number {
    return this.current.currentTime
  }

  set currentTime(seconds: number) {
    this.current.currentTime = Math.max(0, seconds)
  }

  get duration(): number {
    return Number.isFinite(this.current.duration) ? this.current.duration : 0
  }

  /** Point the player at `url`; the preloaded element is used when it already holds it. */
  load(url: string): void {
    if (this.current.src === url) return
    if (this.standbyUrl === url) {
      const old = this.current
      old.pause()
      this.current = this.standby
      this.standby = old
      this.standbyUrl = ''
      old.removeAttribute('src')
      old.load()
    } else {
      this.current.src = url
    }
    this.applyVolume(this.current)
    this.current.playbackRate = this.rateValue
    this.events.onTime(0)
    this.events.onDuration(this.duration)
  }

  /** Start buffering what comes next. */
  preload(url: string | null): void {
    if (url === null || url === this.current.src) {
      if (url === null && this.standbyUrl !== '') {
        this.standby.removeAttribute('src')
        this.standby.load()
        this.standbyUrl = ''
      }
      return
    }
    if (this.standbyUrl === url) return
    this.standbyUrl = url
    this.standby.src = url
    this.applyVolume(this.standby)
  }

  play(): Promise<void> {
    return this.current.play()
  }

  pause(): void {
    this.current.pause()
  }

  stop(): void {
    this.current.pause()
    this.current.removeAttribute('src')
    this.current.load()
  }

  get volume(): number {
    return this.volumeValue
  }

  /** 0 … 1.5: above 1 the element stays at 1 and a gain node adds the rest. */
  set volume(value: number) {
    this.volumeValue = Math.min(1.5, Math.max(0, value))
    this.applyVolume(this.current)
    this.applyVolume(this.standby)
  }

  set playbackRate(rate: number) {
    this.rateValue = rate
    this.current.playbackRate = rate
  }

  private applyVolume(el: HTMLAudioElement): void {
    const v = this.volumeValue
    if (v <= 1 && !this.gains.has(el)) {
      el.volume = v
      return
    }
    const gain = this.gainFor(el)
    if (gain === null) {
      el.volume = Math.min(1, v)
      return
    }
    el.volume = 1
    gain.gain.value = v
  }

  private gainFor(el: HTMLAudioElement): GainNode | null {
    const have = this.gains.get(el)
    if (have !== undefined) return have
    try {
      this.context ??= new AudioContext()
      const source = this.context.createMediaElementSource(el)
      const gain = this.context.createGain()
      source.connect(gain)
      gain.connect(this.context.destination)
      this.gains.set(el, gain)
      void this.context.resume()
      return gain
    } catch {
      return null
    }
  }
}
