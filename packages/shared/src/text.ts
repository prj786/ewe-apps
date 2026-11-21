// Text in any encoding, read through the core's media server (`/text/<name>`): the core
// detects the encoding (BOM, UTF-8, else Firefox's chardetng with the file name's language
// or the system's) and answers UTF-8, naming what it read in `X-Ewe-Encoding`. The
// Encoding menus offer TEXT_ENCODINGS to correct a wrong guess.

import { type MediaServer } from './media'

/** An encoding people may pick: the WHATWG name the core answers with, and words for it. */
export interface TextEncoding {
  name: string
  label: string
}

/** The encodings files are still found in, in the order the menus show them. */
export const TEXT_ENCODINGS: readonly TextEncoding[] = [
  { name: 'UTF-8', label: 'Unicode (UTF-8)' },
  { name: 'UTF-16LE', label: 'Unicode (UTF-16)' },
  { name: 'UTF-16BE', label: 'Unicode (UTF-16 big-endian)' },
  { name: 'windows-1252', label: 'Western European (Windows-1252)' },
  { name: 'windows-1250', label: 'Central European (Windows-1250)' },
  { name: 'windows-1251', label: 'Cyrillic (Windows-1251)' },
  { name: 'KOI8-R', label: 'Cyrillic (KOI8-R)' },
  { name: 'windows-1253', label: 'Greek (Windows-1253)' },
  { name: 'windows-1254', label: 'Turkish (Windows-1254)' },
  { name: 'windows-1255', label: 'Hebrew (Windows-1255)' },
  { name: 'windows-1256', label: 'Arabic (Windows-1256)' },
  { name: 'windows-1257', label: 'Baltic (Windows-1257)' },
  { name: 'windows-1258', label: 'Vietnamese (Windows-1258)' },
  { name: 'windows-874', label: 'Thai (Windows-874)' },
  { name: 'GBK', label: 'Chinese Simplified (GBK)' },
  { name: 'Big5', label: 'Chinese Traditional (Big5)' },
  { name: 'Shift_JIS', label: 'Japanese (Shift_JIS)' },
  { name: 'EUC-JP', label: 'Japanese (EUC-JP)' },
  { name: 'EUC-KR', label: 'Korean (EUC-KR)' },
]

/** `GBK` and `gb18030` decode the same (WHATWG): one entry stands for both. */
function same(a: string, b: string): boolean {
  const norm = (s: string) => (s.toLowerCase() === 'gb18030' ? 'gbk' : s.toLowerCase())
  return norm(a) === norm(b)
}

export function isEncoding(a: string | null | undefined, b: string | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && same(a, b)
}

/** Words for an encoding name ("windows-1251" → "Cyrillic (Windows-1251)"). */
export function encodingLabel(name: string): string {
  return TEXT_ENCODINGS.find((e) => same(e.name, name))?.label ?? name
}

/** The short form for a toolbar ("windows-1251" → "Windows-1251", "Shift_JIS" stays). */
export function encodingShort(name: string): string {
  const label = encodingLabel(name)
  const inner = /\(([^)]+)\)$/.exec(label)?.[1]
  return inner ?? name
}

export interface TextOptions {
  /** a WHATWG label to read the file as; null / 'auto' detects */
  encoding?: string | null | undefined
  /** bytes to read (the core's default is 2 MB) */
  max?: number | undefined
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash === -1 ? path : path.slice(slash + 1)
  return name === '' ? 'file' : name
}

/** `http://127.0.0.1:<port>/text/<name>?path=…&t=…[&enc=…][&max=…]` */
export function textUrl(server: MediaServer, path: string, options: TextOptions = {}): string {
  const params = new URLSearchParams({ path, t: server.token })
  if (options.encoding !== undefined && options.encoding !== null && options.encoding !== 'auto')
    params.set('enc', options.encoding)
  if (options.max !== undefined) params.set('max', String(Math.max(1, Math.floor(options.max))))
  return `http://127.0.0.1:${server.port}/text/${encodeURIComponent(baseName(path))}?${params.toString()}`
}

export interface TextFile {
  text: string
  /** the WHATWG name it was read in */
  encoding: string
  /** false: the detector guessed — worth offering the Encoding menu */
  confident: boolean
  /** only the first `max` bytes */
  truncated: boolean
}

/** Read a text file as UTF-8 whatever it was written in. Throws when it cannot be read. */
export async function readText(
  server: MediaServer,
  path: string,
  options: TextOptions = {},
): Promise<TextFile> {
  const response = await fetch(textUrl(server, path, options))
  if (!response.ok) throw new Error(`Could not read ${baseName(path)} (${response.status})`)
  return {
    text: await response.text(),
    encoding: response.headers.get('x-ewe-encoding') ?? 'UTF-8',
    confident: response.headers.get('x-ewe-encoding-confident') !== '0',
    truncated: response.headers.get('x-ewe-truncated') === '1',
  }
}
