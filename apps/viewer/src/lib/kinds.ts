import { extensionOf } from '@ewe/shared'
import type { IconName } from '@ewe/ui'

/** What ewe Viewer does with a file, decided by its name. */
export type DocKind =
  'pdf' | 'epub' | 'comic' | 'markdown' | 'text' | 'docx' | 'sheet' | 'csv' | 'image' | 'other'

const BY_EXT: Record<string, DocKind> = {}
function register(kind: DocKind, exts: string): void {
  for (const ext of exts.split(' ')) BY_EXT[ext] = kind
}
register('pdf', 'pdf')
register('epub', 'epub mobi azw3 fb2 kf8')
register('comic', 'cbz cbr cb7 cbt')
register('markdown', 'md markdown')
register(
  'text',
  'txt rst log nfo srt vtt ini conf cfg toml yaml yml json xml js mjs cjs ts tsx jsx html htm css scss less py rb go rs c h cpp hpp cc java kt swift sh bash zsh fish lua qml php sql vue svelte nix dart zig diff patch desktop service',
)
register('docx', 'docx')
register('sheet', 'xlsx xlsm xls ods')
register('csv', 'csv tsv')
register('image', 'png jpg jpeg gif webp avif bmp svg ico tif tiff heic heif jxl')

export function docKind(path: string): DocKind {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return BY_EXT[extensionOf(name)] ?? 'other'
}

export function baseName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

export function dirName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

export const KIND_ICON: Record<DocKind, IconName> = {
  pdf: 'file-text',
  epub: 'book',
  comic: 'images',
  markdown: 'file-text',
  text: 'file-code',
  docx: 'file-text',
  sheet: 'file-spreadsheet',
  csv: 'file-spreadsheet',
  image: 'image',
  other: 'file-question',
}

export const KIND_LABEL: Record<DocKind, string> = {
  pdf: 'PDF',
  epub: 'Book',
  comic: 'Comic',
  markdown: 'Markdown',
  text: 'Text',
  docx: 'Word document',
  sheet: 'Spreadsheet',
  csv: 'Table',
  image: 'Picture',
  other: 'Document',
}

/** Mime types the open dialog filters on, by kind group. */
export const OPEN_FILTERS: { name: string; extensions: string[] }[] = [
  {
    name: 'Everything ewe Viewer opens',
    extensions: Object.keys(BY_EXT),
  },
  { name: 'PDF', extensions: ['pdf'] },
  {
    name: 'Books and comics',
    extensions: ['epub', 'mobi', 'azw3', 'fb2', 'cbz', 'cbr', 'cb7', 'cbt'],
  },
  {
    name: 'Pictures',
    extensions: Object.entries(BY_EXT)
      .filter(([, k]) => k === 'image')
      .map(([e]) => e),
  },
  { name: 'Office documents', extensions: ['docx', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv'] },
  {
    name: 'Text and code',
    extensions: Object.entries(BY_EXT)
      .filter(([, k]) => k === 'text' || k === 'markdown')
      .map(([e]) => e),
  },
]
