import { describe, expect, it } from 'vitest'
import {
  coverUrl,
  needsPictureConversion,
  pictureUrl,
  rawUrl,
  thumbSizeFor,
  thumbUrl,
} from './media'

const server = { port: 43210, token: 'abc123' }

describe('media urls', () => {
  it('ends raw urls in the file name and carries path and token', () => {
    const url = new URL(rawUrl(server, '/home/me/My Films/a b.mp4'))
    expect(url.origin).toBe('http://127.0.0.1:43210')
    expect(url.pathname).toBe('/raw/a%20b.mp4')
    expect(url.searchParams.get('path')).toBe('/home/me/My Films/a b.mp4')
    expect(url.searchParams.get('t')).toBe('abc123')
  })

  it('names a file for the root and empty names', () => {
    expect(new URL(rawUrl(server, '/')).pathname).toBe('/raw/file')
  })

  it('builds thumb and cover urls', () => {
    const thumb = new URL(thumbUrl(server, '/x/y.png'))
    expect(thumb.pathname).toBe('/thumb')
    expect(thumb.searchParams.get('size')).toBe('256')
    expect(new URL(thumbUrl(server, '/x/y.png', 512)).searchParams.get('size')).toBe('512')
    const cover = new URL(coverUrl(server, '/x/y.flac'))
    expect(cover.pathname).toBe('/cover')
    expect(cover.searchParams.get('path')).toBe('/x/y.flac')
  })
})

describe('thumbSizeFor', () => {
  it('picks the smallest served size that covers the device pixels', () => {
    expect(thumbSizeFor(48)).toBe(128)
    expect(thumbSizeFor(128)).toBe(128)
    expect(thumbSizeFor(Math.ceil(126 * 1.8))).toBe(256)
    expect(thumbSizeFor(257)).toBe(512)
    expect(thumbSizeFor(2000)).toBe(512)
  })
})

describe('pictureUrl', () => {
  it('sends phone pictures through the converter and the rest raw', () => {
    const heic = new URL(pictureUrl(server, '/p/IMG_0001.HEIC'))
    expect(heic.pathname).toBe('/picture/IMG_0001.HEIC.jpg')
    expect(heic.searchParams.get('path')).toBe('/p/IMG_0001.HEIC')
    expect(heic.searchParams.get('t')).toBe('abc123')
    expect(needsPictureConversion('/p/a.heif')).toBe(true)
    expect(pictureUrl(server, '/p/a.avif')).toBe(rawUrl(server, '/p/a.avif'))
    expect(pictureUrl(server, '/p/a.jpg')).toBe(rawUrl(server, '/p/a.jpg'))
  })
})
