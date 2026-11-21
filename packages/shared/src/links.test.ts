import { describe, expect, it } from 'vitest'
import { isDirectMediaUrl, isWebUrl, linkHost, linksInText } from './links'

describe('links', () => {
  it('knows a media file link from a web page', () => {
    expect(isDirectMediaUrl('https://example.com/live/master.m3u8?x=1')).toBe(true)
    expect(isDirectMediaUrl('https://cdn.example.com/a/b/Clip.MP4')).toBe(true)
    expect(isDirectMediaUrl('https://example.com/stream.mpd')).toBe(true)
    expect(isDirectMediaUrl('rtsp://cam.local/stream')).toBe(true)
    expect(isDirectMediaUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ')).toBe(false)
    expect(isDirectMediaUrl('https://vimeo.com/76979871')).toBe(false)
    expect(isDirectMediaUrl('https://www.bbc.com/news/av/world-europe-59468682')).toBe(false)
    expect(isDirectMediaUrl('https://example.com/page.html')).toBe(false)
    expect(isDirectMediaUrl('not a url')).toBe(false)
  })
  it('names the site', () => {
    expect(linkHost('https://www.youtube.com/watch?v=x')).toBe('youtube.com')
    expect(linkHost('https://clips.twitch.tv/x')).toBe('clips.twitch.tv')
    expect(linkHost('nope')).toBe('nope')
  })
  it('opens only web links elsewhere', () => {
    expect(isWebUrl('https://youtube.com/watch?v=x')).toBe(true)
    expect(isWebUrl('rtsp://cam/x')).toBe(false)
  })
  it('finds links in dropped text', () => {
    expect(
      linksInText(
        '# a comment\r\nhttps://youtu.be/x\nfile:///home/me/a.mp4\n  https://b.example/v  \n',
      ),
    ).toEqual(['https://youtu.be/x', 'https://b.example/v'])
    expect(linksInText('just words')).toEqual([])
  })
})
