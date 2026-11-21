import { describe, expect, it } from 'vitest'
import {
  clampVolume,
  codecWords,
  decodeFailureMessage,
  itemTitle,
  subtitleLanguage,
  type FailureFacts,
  type ProbedStream,
  formatClock,
  formatSpeed,
  moveItem,
  nextIndex,
  previousIndex,
  rememberPosition,
  sortMedia,
  stepSpeed,
  subtitleLabel,
  toMediaItem,
} from './player'
import type { MediaSupport, ResolvedLink } from './links'

describe('speed and volume', () => {
  it('steps through the preset speeds and clamps', () => {
    expect(stepSpeed(1, 1)).toBe(1.25)
    expect(stepSpeed(1, -1)).toBe(0.75)
    expect(stepSpeed(3, 1)).toBe(3)
    expect(stepSpeed(0.25, -1)).toBe(0.25)
    expect(stepSpeed(1.1, 1)).toBe(1.25)
    expect(stepSpeed(1.1, -1)).toBe(1)
    expect(formatSpeed(1)).toBe('1×')
    expect(formatSpeed(1.25)).toBe('1.25×')
  })
  it('allows volume up to 150 %', () => {
    expect(clampVolume(2)).toBe(1.5)
    expect(clampVolume(-1)).toBe(0)
    expect(clampVolume(Number.NaN)).toBe(1)
  })
})

describe('clock', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65.9)).toBe('1:05')
    expect(formatClock(3661)).toBe('1:01:01')
    expect(formatClock(30, true)).toBe('-0:30')
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('–:––')
  })
})

describe('queue', () => {
  it('finds the next item per repeat mode', () => {
    expect(nextIndex(0, 3, 'off', false)).toBe(1)
    expect(nextIndex(2, 3, 'off', false)).toBeNull()
    expect(nextIndex(2, 3, 'off', true)).toBe(0)
    expect(nextIndex(2, 3, 'all', false)).toBe(0)
    expect(nextIndex(1, 3, 'one', false)).toBe(1)
    expect(nextIndex(1, 3, 'one', true)).toBe(2)
    expect(nextIndex(0, 0, 'all', true)).toBeNull()
    expect(previousIndex(0, 3)).toBe(2)
    expect(previousIndex(0, 0)).toBeNull()
  })
  it('reorders items', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 4)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
  })
})

describe('media items', () => {
  it('turns paths and URLs into items', () => {
    expect(toMediaItem('/v/Clip 2.mkv')).toEqual({
      path: '/v/Clip 2.mkv',
      name: 'Clip 2.mkv',
      kind: 'video',
      remote: false,
    })
    expect(toMediaItem('/m/song.flac')?.kind).toBe('audio')
    expect(toMediaItem('/m/notes.txt')).toBeNull()
    const hls = toMediaItem('https://example.com/live/master.m3u8?x=1')
    expect(hls).toMatchObject({ remote: true, name: 'master.m3u8', kind: 'video' })
    expect(toMediaItem('http://cam.local:8080/')?.name).toBe('cam.local:8080')
  })
  it('titles items by what the site said, else by name', () => {
    const watch = toMediaItem('https://www.youtube.com/watch?v=aqz-KE-bpKQ')
    expect(watch?.name).toBe('youtube.com')
    if (watch === null) return
    expect(itemTitle(watch)).toBe('youtube.com')
    expect(itemTitle({ ...watch, title: 'Big Buck Bunny' })).toBe('Big Buck Bunny')
    expect(itemTitle({ path: '/v/Clip.mkv', name: 'Clip.mkv', kind: 'video', remote: false })).toBe(
      'Clip',
    )
  })
  it('sorts naturally', () => {
    const items = ['e10.mp4', 'E2.mp4', 'e1.mp4'].map((n) => toMediaItem(`/x/${n}`))
    expect(sortMedia(items.filter((i) => i !== null)).map((i) => i.name)).toEqual([
      'e1.mp4',
      'E2.mp4',
      'e10.mp4',
    ])
  })
})

describe('subtitles', () => {
  it('labels sidecar files by their language tags', () => {
    expect(subtitleLabel('/v/Movie.en.srt', '/v/Movie.mkv')).toBe('English')
    expect(subtitleLabel('/v/Movie.de.forced.ass', '/v/Movie.mkv')).toBe('Deutsch (forced)')
    expect(subtitleLabel('/v/Movie.srt', '/v/Movie.mkv')).toBe('Subtitles (SRT)')
    expect(subtitleLabel('/v/Movie.eng.sdh.vtt', '/v/Movie.mkv')).toBe('English (SDH)')
    expect(subtitleLabel('/v/Movie.Director Notes.srt', '/v/Movie.mkv')).toBe('Director Notes')
    expect(subtitleLabel('/v/Movie.rus.srt', '/v/Movie.mkv')).toBe('Русский')
    expect(subtitleLabel('/v/Movie.ka.srt', '/v/Movie.mkv')).toBe('ქართული')
  })
  it('reads the language code out of a sidecar name', () => {
    expect(subtitleLanguage('/v/Movie.eng.sdh.srt', '/v/Movie.mkv')).toBe('en')
    expect(subtitleLanguage('/v/Movie.ger.srt', '/v/Movie.mkv')).toBe('de')
    expect(subtitleLanguage('/v/Movie.srt', '/v/Movie.mkv')).toBeNull()
    expect(subtitleLanguage('/v/Movie.Director Notes.srt', '/v/Movie.mkv')).toBeNull()
  })
})

describe('codec words', () => {
  it('names codecs and knows which need gst-libav', () => {
    expect(codecWords('hevc')).toEqual({ label: 'HEVC (H.265) video', needsLibav: false })
    expect(codecWords('wmv2').needsLibav).toBe(true)
    expect(codecWords('pcm_s16le').needsLibav).toBe(false)
    expect(codecWords('zork').label).toContain('unknown')
  })
  const wmv: ProbedStream[] = [
    { kind: 'video', codec: 'wmv2', language: null, title: null },
    { kind: 'audio', codec: 'wmav2', language: null, title: null },
  ]
  const withLibav: MediaSupport = { libav: true, ytdlp: true, mpv: true }
  const noLibav: MediaSupport = { libav: false, ytdlp: true, mpv: true }
  const link = (patch: Partial<ResolvedLink>): ResolvedLink => ({
    kind: 'page',
    url: 'https://www.youtube.com/watch?v=x',
    route: null,
    title: null,
    duration: null,
    thumbnail: null,
    site: 'youtube.com',
    live: false,
    problem: 'no-video',
    message: null,
    entries: [],
    ...patch,
  })
  const facts = (patch: Partial<FailureFacts>): FailureFacts => ({
    name: 'Holiday.wmv',
    remote: false,
    streams: null,
    mediaErrorCode: 4,
    support: withLibav,
    ...patch,
  })

  it('asks for gst-libav only when it really is missing', () => {
    const msg = decodeFailureMessage(facts({ streams: wmv, support: noLibav }))
    expect(msg.title).toBe('Cannot play Holiday.wmv')
    expect(msg.kind).toBe('libav')
    expect(msg.detail).toBe(
      'It uses Windows Media video and Windows Media audio. Decoding it needs gst-libav (FFmpeg codecs for GStreamer), which is not installed. Install it with Komble or `sudo pacman -S gst-libav`.',
    )
    expect(msg.actions).toEqual(['open-with'])
    const unknown = decodeFailureMessage(facts({ name: 'x.bin', streams: [], support: noLibav }))
    expect(unknown.kind).toBe('libav')
    expect(unknown.detail).toContain('gst-libav')
  })

  it('names the codec when the decoder is there and refused', () => {
    const msg = decodeFailureMessage(facts({ streams: wmv }))
    expect(msg.kind).toBe('codec')
    expect(msg.detail).toBe(
      'It uses Windows Media video and Windows Media audio. The decoder for it on this machine refused the file.',
    )
    expect(msg.detail).not.toContain('gst-libav')
    // support unknown: no package is blamed either
    expect(decodeFailureMessage(facts({ streams: wmv, support: null })).kind).toBe('codec')
    const stream = decodeFailureMessage(
      facts({
        name: 'clip',
        remote: true,
        streams: [{ kind: 'video', codec: 'h264', language: null, title: null }],
      }),
    )
    expect(stream.detail).toBe(
      'It uses H.264 video. The decoder for it on this machine refused the stream.',
    )
    expect(stream.actions).toEqual(['mpv', 'browser'])
  })

  it('never blames GStreamer for a web page', () => {
    const page = decodeFailureMessage(
      facts({ name: 'watch', remote: true, streams: null, link: link({ problem: 'no-video' }) }),
    )
    expect(page.title).toBe('This is a web page, not a video file')
    expect(page.kind).toBe('page')
    expect(page.detail).not.toMatch(/GStreamer|gst-libav/)
    expect(page.actions).toEqual(['browser'])
    const noTool = decodeFailureMessage(
      facts({ name: 'watch', remote: true, link: link({ problem: 'no-ytdlp' }) }),
    )
    expect(noTool.kind).toBe('needs-ytdlp')
    expect(noTool.detail).toContain('sudo pacman -S yt-dlp')
    const drm = decodeFailureMessage(
      facts({ remote: true, link: link({ problem: 'drm', site: 'vimeo.com' }) }),
    )
    expect(drm.detail).toBe('vimeo.com protects it with DRM, so it plays only on the site itself.')
    const failed = decodeFailureMessage(
      facts({
        remote: true,
        link: link({ kind: 'failed', problem: 'error', message: 'This video is private.' }),
      }),
    )
    expect(failed.title).toBe('Could not get the video')
    expect(failed.detail).toBe('This video is private.')
    expect(failed.actions).toEqual(['retry', 'browser'])
    const pieces = decodeFailureMessage(
      facts({ name: 'Talk', remote: true, link: link({ problem: 'unplayable' }) }),
    )
    expect(pieces.actions[0]).toBe('mpv')
  })

  it('says what it can when nothing is known', () => {
    expect(decodeFailureMessage(facts({ streams: null })).detail).toBe(
      'GStreamer on this machine could not open it.',
    )
    expect(decodeFailureMessage(facts({ streams: [] })).detail).toContain('may be damaged')
    expect(decodeFailureMessage(facts({ mediaErrorCode: 2 })).kind).toBe('network')
    const remote = decodeFailureMessage(facts({ remote: true, mediaErrorCode: 2 }))
    expect(remote.actions).toEqual(['retry', 'browser'])
    expect(
      decodeFailureMessage(facts({ remote: true, link: link({ kind: 'direct', problem: null }) }))
        .detail,
    ).toBe('The address did not answer with a video or sound ewe Player can play.')
  })
})

describe('resume positions', () => {
  it('keeps positions only when worth resuming and caps the list', () => {
    let saved = rememberPosition({}, '/a', 120, 3600, 1)
    expect(saved['/a']).toEqual({ position: 120, duration: 3600, at: 1 })
    saved = rememberPosition(saved, '/a', 3595, 3600, 2)
    expect(saved['/a']).toBeUndefined()
    saved = rememberPosition(saved, '/short', 20, 50, 3)
    expect(saved['/short']).toBeUndefined()
    for (let i = 0; i < 505; i++) saved = rememberPosition(saved, `/f${i}`, 100, 1000, i + 10)
    expect(Object.keys(saved).length).toBe(500)
    expect(saved['/f0']).toBeUndefined()
    expect(saved['/f504']).toBeDefined()
  })
})
