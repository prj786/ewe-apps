import { describe, expect, it } from 'vitest'
import {
  isLanguagePreference,
  languageBase,
  nativeLanguageName,
  preferredTrack,
  systemLanguage,
  trackLabel,
  wantedLanguage,
  wantsSubtitles,
} from './languages'

describe('language names', () => {
  it('writes languages in their own words from ISO 639-1 and 639-2 codes', () => {
    expect(nativeLanguageName('eng')).toBe('English')
    expect(nativeLanguageName('en')).toBe('English')
    expect(nativeLanguageName('rus')).toBe('Русский')
    expect(nativeLanguageName('kat')).toBe('ქართული')
    expect(nativeLanguageName('geo')).toBe('ქართული')
    expect(nativeLanguageName('jpn')).toBe('日本語')
    expect(nativeLanguageName('ger')).toBe('Deutsch')
    expect(nativeLanguageName('deu')).toBe('Deutsch')
    expect(nativeLanguageName('fre')).toBe('Français')
    expect(nativeLanguageName('ara')).toBe('العربية')
    expect(nativeLanguageName('UKR')).toBe('Українська')
    expect(nativeLanguageName('iw')).toBe('עברית')
  })
  it('tells regional spellings apart where a menu needs it', () => {
    expect(nativeLanguageName('zh-TW')).toBe('繁體中文')
    expect(nativeLanguageName('zh-Hans')).toBe('简体中文')
    expect(nativeLanguageName('pt-BR')).toBe('Português (Brasil)')
    expect(nativeLanguageName('pt_PT')).toBe('Português (Portugal)')
    expect(nativeLanguageName('de-AT')).toBe('Deutsch')
  })
  it('knows when a tag names no language', () => {
    expect(nativeLanguageName('und')).toBeNull()
    expect(nativeLanguageName('')).toBeNull()
    expect(nativeLanguageName(null)).toBeNull()
    expect(nativeLanguageName('English')).toBeNull()
    expect(languageBase('mul')).toBeNull()
  })
  it('reduces tags to a base code', () => {
    expect(languageBase('eng')).toBe('en')
    expect(languageBase('pt-BR')).toBe('pt')
    expect(languageBase('fil')).toBe('fil')
    expect(languageBase('ka_GE.UTF-8')).toBe('ka')
  })
})

describe('track labels', () => {
  it('shows the language, and the title when it says more', () => {
    expect(trackLabel({ language: 'rus' }, 0, 'Audio')).toBe('Русский')
    expect(trackLabel({ language: 'en', label: 'Commentary' }, 1, 'Audio')).toBe(
      'English · Commentary',
    )
    expect(trackLabel({ language: 'rus', label: 'Russian' }, 0, 'Audio')).toBe('Русский')
    expect(trackLabel({ language: 'eng', label: 'eng' }, 0, 'Audio')).toBe('English')
    expect(trackLabel({ language: 'ka', label: 'ქართული' }, 0, 'Audio')).toBe('ქართული')
    expect(trackLabel({ language: '', label: 'Director' }, 2, 'Audio')).toBe('Director')
    expect(trackLabel({ language: '', label: 'jpn' }, 2, 'Subtitles')).toBe('日本語')
    expect(trackLabel({ language: 'und', label: '' }, 2, 'Audio')).toBe('Audio 3')
  })
})

describe('preferred languages', () => {
  it('takes the system language from the environment', () => {
    expect(systemLanguage(['ru-RU', 'en-US'])).toBe('ru')
    expect(systemLanguage(['C', 'ka'])).toBe('ka')
    expect(systemLanguage([])).toBe('en')
  })
  it('validates stored preferences', () => {
    expect(isLanguagePreference('auto', false)).toBe(true)
    expect(isLanguagePreference('off', true)).toBe(true)
    expect(isLanguagePreference('off', false)).toBe(false)
    expect(isLanguagePreference('ru', false)).toBe(true)
    expect(isLanguagePreference('rus', false)).toBe(false)
    expect(isLanguagePreference(3, true)).toBe(false)
  })
  it('turns a preference into the wanted language', () => {
    expect(wantedLanguage('auto', 'ru')).toBe('ru')
    expect(wantedLanguage('off', 'ru')).toBeNull()
    expect(wantedLanguage('ka', 'en')).toBe('ka')
  })
  it('picks the first track in the wanted language', () => {
    const tracks = [
      { id: 'a', language: 'eng' },
      { id: 'b', language: 'rus' },
      { id: 'c', language: 'ru' },
    ]
    expect(preferredTrack(tracks, (t) => t.language, 'ru')?.id).toBe('b')
    expect(preferredTrack(tracks, (t) => t.language, 'ja')).toBeUndefined()
    expect(preferredTrack(tracks, (t) => t.language, null)).toBeUndefined()
  })
  it('turns subtitles on only when the sound is in another language', () => {
    expect(wantsSubtitles('en', 'eng')).toBe(false)
    expect(wantsSubtitles('en', 'rus')).toBe(true)
    expect(wantsSubtitles('en', null)).toBe(true)
    expect(wantsSubtitles(null, 'rus')).toBe(false)
  })
})
