import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEXT_ENCODINGS, encodingLabel, encodingShort, isEncoding, readText, textUrl } from './text'

const server = { port: 43210, token: 'abc123' }

describe('textUrl', () => {
  it('names the file and carries path, token, encoding and size', () => {
    const url = new URL(textUrl(server, '/home/me/Фильм.ru.srt'))
    expect(url.pathname).toBe(`/text/${encodeURIComponent('Фильм.ru.srt')}`)
    expect(url.searchParams.get('path')).toBe('/home/me/Фильм.ru.srt')
    expect(url.searchParams.get('t')).toBe('abc123')
    expect(url.searchParams.has('enc')).toBe(false)
    const forced = new URL(textUrl(server, '/a.txt', { encoding: 'windows-1251', max: 4096 }))
    expect(forced.searchParams.get('enc')).toBe('windows-1251')
    expect(forced.searchParams.get('max')).toBe('4096')
    expect(new URL(textUrl(server, '/a.txt', { encoding: 'auto' })).searchParams.has('enc')).toBe(
      false,
    )
  })
})

describe('encoding names', () => {
  it('has words for every listed encoding and keeps unknown ones as they are', () => {
    expect(encodingLabel('windows-1251')).toBe('Cyrillic (Windows-1251)')
    expect(encodingLabel('gb18030')).toBe('Chinese Simplified (GBK)')
    expect(encodingLabel('IBM866')).toBe('IBM866')
    expect(encodingShort('Shift_JIS')).toBe('Shift_JIS')
    expect(encodingShort('UTF-8')).toBe('UTF-8')
    expect(encodingShort('windows-1256')).toBe('Windows-1256')
    expect(isEncoding('GBK', 'gb18030')).toBe(true)
    expect(isEncoding('UTF-8', 'utf-8')).toBe(true)
    expect(isEncoding('UTF-8', null)).toBe(false)
    expect(new Set(TEXT_ENCODINGS.map((e) => e.name)).size).toBe(TEXT_ENCODINGS.length)
  })
})

describe('readText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the text with what the core says about it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('Привет', {
            headers: {
              'x-ewe-encoding': 'windows-1251',
              'x-ewe-encoding-confident': '0',
              'x-ewe-truncated': '1',
            },
          }),
        ),
      ),
    )
    const got = await readText(server, '/a.srt')
    expect(got).toEqual({
      text: 'Привет',
      encoding: 'windows-1251',
      confident: false,
      truncated: true,
    })
  })

  it('throws on an error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 404 }))),
    )
    await expect(readText(server, '/gone.txt')).rejects.toThrow('gone.txt')
  })
})
