import { describe, expect, it } from 'vitest'
import {
  clampVolume,
  codecWords,
  decodeFailureMessage,
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
    expect(subtitleLabel('/v/Movie.de.forced.ass', '/v/Movie.mkv')).toBe('German (forced)')
    expect(subtitleLabel('/v/Movie.srt', '/v/Movie.mkv')).toBe('Subtitles (SRT)')
    expect(subtitleLabel('/v/Movie.eng.sdh.vtt', '/v/Movie.mkv')).toBe('English (SDH)')
    expect(subtitleLabel('/v/Movie.Director Notes.srt', '/v/Movie.mkv')).toBe('Director Notes')
  })
})

describe('codec words', () => {
  it('names codecs and knows which need gst-libav', () => {
    expect(codecWords('hevc')).toEqual({ label: 'HEVC (H.265) video', needsLibav: false })
    expect(codecWords('wmv2').needsLibav).toBe(true)
    expect(codecWords('pcm_s16le').needsLibav).toBe(false)
    expect(codecWords('zork').label).toContain('unknown')
  })
  it('writes a plain sentence for a decode failure', () => {
    const msg = decodeFailureMessage(
      'Holiday.wmv',
      [
        { kind: 'video', codec: 'wmv2', language: null, title: null },
        { kind: 'audio', codec: 'wmav2', language: null, title: null },
      ],
      4,
    )
    expect(msg.title).toBe('Cannot play Holiday.wmv')
    expect(msg.detail).toBe(
      'It uses Windows Media video and Windows Media audio. Decoding it needs the gst-libav package (FFmpeg codecs for GStreamer).',
    )
    expect(msg.suggestLibav).toBe(true)
    const unknown = decodeFailureMessage('x.bin', null, 4)
    expect(unknown.detail).toContain('not one GStreamer')
    const fine = decodeFailureMessage(
      'a.mp4',
      [{ kind: 'video', codec: 'h264', language: null, title: null }],
      3,
    )
    expect(fine.suggestLibav).toBe(false)
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
