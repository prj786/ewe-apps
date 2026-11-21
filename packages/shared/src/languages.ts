// Languages of audio and subtitle tracks in their own words ("Русский", not "rus"), and the
// player's preferred-language rules. Pure (no DOM), tested with vitest.

/** ISO 639-1 code → the language's own name, written the way a menu shows it. */
const NATIVE: Readonly<Record<string, string>> = {
  af: 'Afrikaans',
  am: 'አማርኛ',
  ar: 'العربية',
  as: 'অসমীয়া',
  az: 'Azərbaycanca',
  be: 'Беларуская',
  bg: 'Български',
  bn: 'বাংলা',
  bo: 'བོད་སྐད',
  bs: 'Bosanski',
  ca: 'Català',
  cs: 'Čeština',
  cy: 'Cymraeg',
  da: 'Dansk',
  de: 'Deutsch',
  el: 'Ελληνικά',
  en: 'English',
  eo: 'Esperanto',
  es: 'Español',
  et: 'Eesti',
  eu: 'Euskara',
  fa: 'فارسی',
  fi: 'Suomi',
  fil: 'Filipino',
  fo: 'Føroyskt',
  fr: 'Français',
  ga: 'Gaeilge',
  gd: 'Gàidhlig',
  gl: 'Galego',
  gu: 'ગુજરાતી',
  he: 'עברית',
  hi: 'हिन्दी',
  hr: 'Hrvatski',
  hu: 'Magyar',
  hy: 'Հայերեն',
  id: 'Bahasa Indonesia',
  is: 'Íslenska',
  it: 'Italiano',
  ja: '日本語',
  jv: 'Basa Jawa',
  ka: 'ქართული',
  kk: 'Қазақ тілі',
  km: 'ខ្មែរ',
  kn: 'ಕನ್ನಡ',
  ko: '한국어',
  ku: 'Kurdî',
  ky: 'Кыргызча',
  la: 'Latina',
  lb: 'Lëtzebuergesch',
  lo: 'ລາວ',
  lt: 'Lietuvių',
  lv: 'Latviešu',
  mk: 'Македонски',
  ml: 'മലയാളം',
  mn: 'Монгол',
  mr: 'मराठी',
  ms: 'Bahasa Melayu',
  mt: 'Malti',
  my: 'မြန်မာ',
  nb: 'Norsk bokmål',
  ne: 'नेपाली',
  nl: 'Nederlands',
  nn: 'Norsk nynorsk',
  no: 'Norsk',
  or: 'ଓଡ଼ିଆ',
  pa: 'ਪੰਜਾਬੀ',
  pl: 'Polski',
  ps: 'پښتو',
  pt: 'Português',
  ro: 'Română',
  ru: 'Русский',
  si: 'සිංහල',
  sk: 'Slovenčina',
  sl: 'Slovenščina',
  so: 'Soomaali',
  sq: 'Shqip',
  sr: 'Српски',
  sv: 'Svenska',
  sw: 'Kiswahili',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  tg: 'Тоҷикӣ',
  th: 'ไทย',
  tk: 'Türkmençe',
  tl: 'Tagalog',
  tr: 'Türkçe',
  tt: 'Татарча',
  uk: 'Українська',
  ur: 'اردو',
  uz: 'Oʻzbekcha',
  vi: 'Tiếng Việt',
  yi: 'ייִדיש',
  yo: 'Yorùbá',
  zh: '中文',
  zu: 'isiZulu',
}

/** ISO 639-2 (both the /T and the /B spelling) and retired codes → ISO 639-1. */
const TO_TWO: Readonly<Record<string, string>> = {
  afr: 'af',
  alb: 'sq',
  amh: 'am',
  ara: 'ar',
  arm: 'hy',
  asm: 'as',
  aze: 'az',
  baq: 'eu',
  bel: 'be',
  ben: 'bn',
  bod: 'bo',
  bos: 'bs',
  bul: 'bg',
  bur: 'my',
  cat: 'ca',
  ces: 'cs',
  chi: 'zh',
  cym: 'cy',
  cze: 'cs',
  dan: 'da',
  deu: 'de',
  dut: 'nl',
  ell: 'el',
  eng: 'en',
  epo: 'eo',
  est: 'et',
  eus: 'eu',
  fao: 'fo',
  fas: 'fa',
  fin: 'fi',
  fra: 'fr',
  fre: 'fr',
  geo: 'ka',
  ger: 'de',
  gla: 'gd',
  gle: 'ga',
  glg: 'gl',
  gre: 'el',
  guj: 'gu',
  heb: 'he',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  hye: 'hy',
  ice: 'is',
  ind: 'id',
  isl: 'is',
  ita: 'it',
  jav: 'jv',
  jpn: 'ja',
  kan: 'kn',
  kat: 'ka',
  kaz: 'kk',
  khm: 'km',
  kir: 'ky',
  kor: 'ko',
  kur: 'ku',
  lao: 'lo',
  lat: 'la',
  lav: 'lv',
  lit: 'lt',
  ltz: 'lb',
  mac: 'mk',
  mal: 'ml',
  mar: 'mr',
  may: 'ms',
  mkd: 'mk',
  mlt: 'mt',
  mon: 'mn',
  msa: 'ms',
  mya: 'my',
  nep: 'ne',
  nld: 'nl',
  nno: 'nn',
  nob: 'nb',
  nor: 'no',
  ori: 'or',
  pan: 'pa',
  per: 'fa',
  pol: 'pl',
  por: 'pt',
  pus: 'ps',
  ron: 'ro',
  rum: 'ro',
  rus: 'ru',
  sin: 'si',
  slk: 'sk',
  slo: 'sk',
  slv: 'sl',
  som: 'so',
  spa: 'es',
  sqi: 'sq',
  srp: 'sr',
  swa: 'sw',
  swe: 'sv',
  tam: 'ta',
  tat: 'tt',
  tel: 'te',
  tgk: 'tg',
  tgl: 'tl',
  tha: 'th',
  tib: 'bo',
  tuk: 'tk',
  tur: 'tr',
  ukr: 'uk',
  urd: 'ur',
  uzb: 'uz',
  vie: 'vi',
  wel: 'cy',
  yid: 'yi',
  yor: 'yo',
  zho: 'zh',
  zul: 'zu',
  // retired ISO 639-1 codes some old files still carry
  iw: 'he',
  in: 'id',
  ji: 'yi',
}

/** "No language" markers: undetermined, multiple, no linguistic content, uncoded. */
const NONE = new Set(['und', 'mul', 'zxx', 'mis', 'qaa', 'xx', 'none', 'unknown'])

/** Regional spellings worth telling apart in a menu. */
const VARIANTS: Readonly<Record<string, string>> = {
  'zh-hans': '简体中文',
  'zh-cn': '简体中文',
  'zh-sg': '简体中文',
  'zh-hant': '繁體中文',
  'zh-tw': '繁體中文',
  'zh-hk': '繁體中文',
  'zh-mo': '繁體中文',
  'pt-br': 'Português (Brasil)',
  'pt-pt': 'Português (Portugal)',
  'es-419': 'Español (Latinoamérica)',
  'es-mx': 'Español (México)',
  'en-gb': 'English (UK)',
  'en-us': 'English (US)',
  'fr-ca': 'Français (Canada)',
}

/**
 * The base language of a tag as a short code: `eng` → `en`, `pt-BR` → `pt`, `ger` → `de`,
 * `fil` stays. Null for no language (`und`, empty) or something that is not a tag at all.
 */
export function languageBase(tag: string | null | undefined): string | null {
  if (tag === null || tag === undefined) return null
  const lower = tag.trim().toLowerCase().replace(/_/g, '-')
  const base = lower.split('-')[0] ?? ''
  if (!/^[a-z]{2,3}$/.test(base) || NONE.has(base)) return null
  return TO_TWO[base] ?? base
}

const capitalise = (name: string, code: string): string => {
  const first = name.charAt(0)
  try {
    return first.toLocaleUpperCase(code) + name.slice(1)
  } catch {
    return first.toUpperCase() + name.slice(1)
  }
}

/**
 * A language in its own words: `rus` → "Русский", `kat` → "ქართული", `ja` → "日本語",
 * `zh-TW` → "繁體中文". Codes outside the table ask the platform (Intl.DisplayNames in that
 * language); null when the tag names no language.
 */
export function nativeLanguageName(tag: string | null | undefined): string | null {
  const base = languageBase(tag)
  if (base === null || tag === null || tag === undefined) return null
  const lower = tag.trim().toLowerCase().replace(/_/g, '-')
  const rest = lower.split('-').slice(1)
  for (const part of rest) {
    const variant = VARIANTS[`${base}-${part}`]
    if (variant !== undefined) return variant
  }
  const known = NATIVE[base]
  if (known !== undefined) return known
  try {
    const name = new Intl.DisplayNames([base], { type: 'language' }).of(base)
    if (name === undefined || name.toLowerCase() === base) return null
    return capitalise(name, base)
  } catch {
    return null
  }
}

/** The English name too, so a track titled "Russian" next to `rus` is not said twice. */
function englishName(base: string): string | null {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(base)
    return name === undefined || name.toLowerCase() === base ? null : name
  } catch {
    return null
  }
}

export interface TrackInfo {
  language?: string | null | undefined
  /** the track's title (`label` in the DOM, the `title` tag in the file) */
  label?: string | null | undefined
}

/**
 * The line a track menu shows: "English", "Русский · Commentary", "Audio 2". The title is
 * dropped when it only repeats the language (`eng`, "English", "Russian", "Русский").
 */
export function trackLabel(track: TrackInfo, index: number, noun: string): string {
  const language = nativeLanguageName(track.language)
  const base = languageBase(track.language)
  const title = (track.label ?? '').trim()
  const repeats = (text: string): boolean => {
    const t = text.toLowerCase()
    if (base === null) return false
    return (
      t === (track.language ?? '').trim().toLowerCase() ||
      t === base ||
      t === (language ?? '').toLowerCase() ||
      t === (englishName(base) ?? '').toLowerCase()
    )
  }
  if (language !== null) {
    return title === '' || repeats(title) ? language : `${language} · ${title}`
  }
  if (title !== '') return nativeLanguageName(title) ?? title
  return `${noun} ${index + 1}`
}

/** The system's language as a base code: `navigator.languages` → "en", "ru", "ka". */
export function systemLanguage(languages: readonly string[]): string {
  for (const tag of languages) {
    const base = languageBase(tag)
    if (base !== null) return base
  }
  return 'en'
}

/** A preference as stored: `auto` (the system's language), `off` (subtitles only) or a code. */
export type LanguagePreference = string

export function isLanguagePreference(value: unknown, allowOff: boolean): value is string {
  if (typeof value !== 'string') return false
  if (value === 'auto') return true
  if (value === 'off') return allowOff
  return languageBase(value) === value
}

/** The language a preference asks for, or null for "off". */
export function wantedLanguage(preference: LanguagePreference, system: string): string | null {
  if (preference === 'off') return null
  if (preference === 'auto') return languageBase(system) ?? 'en'
  return languageBase(preference)
}

/** The first track in the wanted language, if any. */
export function preferredTrack<T>(
  tracks: readonly T[],
  languageOf: (track: T) => string | null | undefined,
  wanted: string | null,
): T | undefined {
  if (wanted === null) return undefined
  return tracks.find((t) => languageBase(languageOf(t)) === wanted)
}

/**
 * Whether subtitles in `subtitles` should come on by themselves: not when they are off, and
 * not when the sound is already in that language (an English film for an English reader).
 * Unknown audio counts as foreign — most files carry no language tag.
 */
export function wantsSubtitles(
  subtitles: string | null,
  audio: string | null | undefined,
): boolean {
  if (subtitles === null) return false
  const spoken = languageBase(audio)
  return spoken === null || spoken !== subtitles
}
