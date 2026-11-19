// What ewe Viewer uses of foliate-js' view.js (the library ships no types).

export interface FoliateTocItem {
  label: string
  href?: string | undefined
  subitems?: FoliateTocItem[] | undefined
}

export interface FoliateBook {
  metadata?:
    | {
        title?: string | Record<string, string> | undefined
        author?: unknown
        language?: string | string[] | undefined
      }
    | undefined
  toc?: FoliateTocItem[] | undefined
  sections: { linear?: string | undefined; size?: number | undefined }[]
  dir?: string | undefined
  rendition?: { layout?: string | undefined } | undefined
}

export interface FoliateLocation {
  /** 0–1 through the whole book */
  fraction?: number | undefined
  cfi?: string | undefined
  tocItem?: FoliateTocItem | undefined
  location?: { current: number; next: number; total: number } | undefined
  section?: { current: number; total: number } | undefined
  time?: { section: number; total: number } | undefined
}

export interface FoliateRenderer extends HTMLElement {
  setStyles(css: string | string[]): void
  next(distance?: number): Promise<void>
  prev(distance?: number): Promise<void>
  scrolled?: boolean
}

export interface FoliateView extends HTMLElement {
  book: FoliateBook
  renderer: FoliateRenderer
  lastLocation?: FoliateLocation | undefined
  open(file: Blob | string): Promise<void>
  close(): void
  init(options: { lastLocation?: string | undefined; showTextStart?: boolean | undefined }): Promise<void>
  goTo(target: string | number | { fraction: number }): Promise<void>
  goToFraction(fraction: number): Promise<void>
  prev(distance?: number): Promise<void>
  next(distance?: number): Promise<void>
  goLeft(): Promise<void>
  goRight(): Promise<void>
  getCFI(index: number, range?: Range): string
  search(options: { query: string; index?: number }): AsyncGenerator<unknown>
  clearSearch(): void
  getSectionFractions(): number[]
}

export class ResponseError extends Error {}
export class NotFoundError extends Error {}
export class UnsupportedTypeError extends Error {}
export function makeBook(file: Blob | string): Promise<FoliateBook>
export class View extends HTMLElement {}
