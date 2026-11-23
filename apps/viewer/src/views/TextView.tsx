// Markdown, plain text and code — ported from ewe Browser's files/textview.tsx:
// highlight.js core with 24 languages (colours mapped to Ewe tokens in app.css), marked +
// DOMPurify for Markdown (relative images rewritten to raw URLs), the first 2 MB of big
// files, plus a Source / Preview switch, wrap, and the scroll position remembered.
// The text comes from the core's `/text` route in whatever encoding it was written
// (Windows-1251, Shift_JIS, GBK…); the Encoding menu corrects a wrong guess and is
// remembered per file.

import {
  Match,
  Show,
  Switch,
  createEffect,
  createResource,
  createSignal,
  on,
  untrack,
  type JSX,
} from 'solid-js'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import lua from 'highlight.js/lib/languages/lua'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { marked } from 'marked'
import {
  TEXT_ENCODINGS,
  encodingLabel,
  encodingShort,
  extensionOf,
  formatBytes,
  isEncoding,
  rawUrl,
  readText,
} from '@ewe/shared'
import {
  Button,
  EmptyState,
  IconButton,
  Menu,
  Segmented,
  Toolbar,
  addRecent,
  toast,
  type MenuEntry,
} from '@ewe/ui'
import { fileStat, openExternal } from '../lib/bridge'
import { inTextInput, isMod, useKeys } from '../lib/keys'
import { baseName, dirName, docKind } from '../lib/kinds'
import { getSetting, recallPosition, savePosition, setSetting } from '../lib/store'
import { flagValue, hasFlag } from '../lib/flags'
import type { ViewProps } from './types'

const LANGUAGES = {
  bash,
  c,
  cpp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  php,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
}
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang)

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  css: 'css',
  scss: 'scss',
  less: 'scss',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  toml: 'ini',
  desktop: 'ini',
  service: 'ini',
  java: 'java',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  qml: 'javascript',
  json: 'json',
  kt: 'kotlin',
  lua: 'lua',
  md: 'markdown',
  markdown: 'markdown',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sql: 'sql',
  swift: 'swift',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

const MAX_BYTES = 2 * 1024 * 1024

// Every block of a Markdown document reads in its own direction: an Arabic or Hebrew
// paragraph, item or heading right to left, an English one left to right.
const BIDI_BLOCKS = new Set([
  'P',
  'LI',
  'UL',
  'OL',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'TABLE',
  'TD',
  'TH',
  'DL',
  'DT',
  'DD',
])
const FONT_STEPS = [11, 12, 13, 14, 16, 18, 20, 24]

export function languageFor(name: string): keyof typeof LANGUAGES | null {
  return BY_EXTENSION[extensionOf(name)] ?? null
}

function setHtml(el: HTMLElement, sanitized: string): void {
  el.innerHTML = sanitized
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

export function resolvePath(dir: string, relative: string): string {
  const parts = dir.split('/')
  for (const part of relative.split('/')) {
    if (part === '..') {
      if (parts.length > 1) parts.pop()
    } else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/') || '/'
}

/** The id GitHub gives a heading: lower case, spaces to dashes, punctuation dropped. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

export function TextView(props: ViewProps): JSX.Element {
  const name = () => baseName(props.path)
  const isMarkdown = () => docKind(props.path) === 'markdown'
  const [mode, setMode] = createSignal<'preview' | 'source'>(
    hasFlag(props.flags ?? [], 'source')
      ? 'source'
      : getSetting<'preview' | 'source'>('mdMode', 'preview'),
  )
  const [wrap, setWrap] = createSignal(getSetting('textWrap', true))
  const [fontSize, setFontSize] = createSignal(getSetting('textFont', 13))
  const [size, setSize] = createSignal(0)
  /** the encoding the person chose; null = detect (undefined: not read from memory yet) */
  const [chosen, setChosen] = createSignal<string | null | undefined>(undefined)
  const [encodingMenu, setEncodingMenu] = createSignal<{ x: number; y: number } | null>(null)
  let scroller: HTMLElement | undefined
  let restored = false

  createEffect(
    on(
      () => props.path,
      (path) => {
        // `--encoding=windows-1251` reads the files of that command line so (not saved)
        const flagged = flagValue(props.flags ?? [], 'encoding')
        if (flagged !== null && flagged !== '') {
          setChosen(flagged === 'auto' ? null : flagged)
          return
        }
        void recallPosition(path).then((saved) =>
          setChosen(
            saved?.encoding === undefined || saved.encoding === 'auto' ? null : saved.encoding,
          ),
        )
      },
    ),
  )

  const [file] = createResource(
    () => {
      const encoding = chosen()
      return encoding === undefined ? null : { path: props.path, encoding }
    },
    async ({ path, encoding }) => {
      const stat = await fileStat(path)
      setSize(stat.size)
      const read = await readText(props.server, path, { encoding, max: MAX_BYTES })
      void addRecent(path).catch(() => undefined)
      const saved = await recallPosition(path)
      if (!restored && saved?.scroll !== undefined) {
        restored = true
        const frac = saved.scroll
        requestAnimationFrame(() => {
          if (scroller !== undefined)
            scroller.scrollTop = frac * (scroller.scrollHeight - scroller.clientHeight)
        })
      }
      return read
    },
  )
  const text = () => file()?.text

  // `--encoding-menu`: the screenshot hook opens the menu once the text is there
  let menuHook = untrack(() => hasFlag(props.flags ?? [], 'encoding-menu'))
  createEffect(
    on(file, (read) => {
      if (!menuHook || read === undefined) return
      menuHook = false
      requestAnimationFrame(() => {
        const r = document.querySelector('.tv-encoding')?.getBoundingClientRect()
        if (r !== undefined) setEncodingMenu({ x: r.right, y: r.bottom + 4 })
      })
    }),
  )

  const chooseEncoding = (encoding: string | null) => {
    setChosen(encoding)
    // 'auto' and not undefined: the memory merges, an absent field would keep the old one
    savePosition(props.path, { encoding: encoding ?? 'auto' })
  }

  const encodingItems = (): MenuEntry[] => {
    const read = file()
    const auto = chosen() === null
    return [
      {
        type: 'item',
        id: 'auto',
        label: 'Automatic',
        hint: auto && read !== undefined ? encodingShort(read.encoding) : undefined,
        icon: auto ? 'check' : undefined,
        run: () => chooseEncoding(null),
      },
      { type: 'separator' },
      ...TEXT_ENCODINGS.map((e): MenuEntry => ({
        type: 'item',
        id: e.name,
        label: e.label,
        icon: !auto && isEncoding(chosen(), e.name) ? 'check' : undefined,
        run: () => chooseEncoding(e.name),
      })),
    ]
  }

  const truncated = () => size() > MAX_BYTES

  const highlighted = () => {
    const body = text() ?? ''
    const language = languageFor(name())
    if (language === null || body.length > 400_000) return escapeHtml(body)
    try {
      return hljs.highlight(body, { language, ignoreIllegals: true }).value
    } catch {
      return escapeHtml(body)
    }
  }

  const lineNumbers = () => {
    const n = (text() ?? '').split('\n').length
    return Array.from({ length: n }, (_, i) => i + 1).join('\n')
  }

  const markdownHtml = () => {
    const dir = dirName(props.path)
    const html = marked.parse(text() ?? '', { async: false, gfm: true })
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (BIDI_BLOCKS.has(node.tagName) && !node.hasAttribute('dir'))
        node.setAttribute('dir', 'auto')
      if (node.tagName === 'A') {
        node.setAttribute('rel', 'noopener')
        return
      }
      // headings get the id their links point at (`[Install](#install)`): marked
      // writes none, and a README's table of contents did nothing
      if (/^H[1-6]$/.test(node.tagName) && !node.hasAttribute('id')) {
        const slug = headingSlug(node.textContent ?? '')
        if (slug !== '') node.setAttribute('id', slug)
        return
      }
      if (node.tagName !== 'IMG') return
      const src = node.getAttribute('src') ?? ''
      if (src !== '' && !/^[a-z]+:/i.test(src)) {
        let decoded = src
        try {
          decoded = decodeURI(src)
        } catch {
          // keep as is
        }
        node.setAttribute('src', rawUrl(props.server, resolvePath(dir, decoded)))
      }
    })
    const clean = DOMPurify.sanitize(html)
    DOMPurify.removeHook('afterSanitizeAttributes')
    return clean
  }

  const onLink = (e: MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (anchor === null) return
    e.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) {
      void openExternal(href).catch(() => toast('Could not open the link', { kind: 'warning' }))
    } else if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1))
      const target =
        scroller?.querySelector(`[id="${CSS.escape(id)}"]`) ??
        scroller?.querySelector(`[name="${CSS.escape(id)}"]`)
      target?.scrollIntoView({ block: 'start' })
    } else if (href !== '' && !/^[a-z]+:/i.test(href)) {
      // marked percent-encodes what it writes: `My Notes.md` arrives as My%20Notes.md
      let file = href.split('#')[0] ?? href
      try {
        file = decodeURIComponent(file)
      } catch {
        // not an encoded name: as it is
      }
      props.onOpen(resolvePath(dirName(props.path), file))
    }
  }

  const onScroll = () => {
    if (scroller === undefined) return
    const range = scroller.scrollHeight - scroller.clientHeight
    savePosition(props.path, { scroll: range <= 0 ? 0 : scroller.scrollTop / range })
  }

  const stepFont = (delta: 1 | -1) => {
    const i = FONT_STEPS.indexOf(fontSize())
    const next =
      FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, (i === -1 ? 2 : i) + delta))]
    if (next !== undefined) {
      setFontSize(next)
      setSetting('textFont', next)
    }
  }

  // deferred: a `--source` flag sets the first value and must not become the default
  createEffect(
    on(
      mode,
      (m) => {
        if (isMarkdown()) setSetting('mdMode', m)
      },
      { defer: true },
    ),
  )

  useKeys(
    () => props.active,
    (e) => {
      if (isMod(e)) {
        if (e.key === '=' || e.key === '+') {
          stepFont(1)
          return true
        }
        if (e.key === '-') {
          stepFont(-1)
          return true
        }
        if (e.key === '0') {
          setFontSize(13)
          setSetting('textFont', 13)
          return true
        }
        return false
      }
      if (inTextInput(e)) return false
      if (isMarkdown() && e.key === 'Tab' && !e.shiftKey) {
        setMode((m) => (m === 'preview' ? 'source' : 'preview'))
        return true
      }
      if (e.key === 'w' && !isMarkdown()) {
        setWrap((w) => {
          setSetting('textWrap', !w)
          return !w
        })
        return true
      }
      if (e.key === 'Home' || e.key === 'End') {
        scroller?.scrollTo({ top: e.key === 'Home' ? 0 : scroller.scrollHeight })
        return true
      }
      if (e.key === 'j' || e.key === 'k') {
        scroller?.scrollBy({ top: (e.key === 'j' ? 1 : -1) * fontSize() * 3 })
        return true
      }
      return false
    },
  )

  return (
    <div class="tv" style={{ '--text-view-size': `${fontSize()}px` }}>
      <Toolbar label="Text" class="view-toolbar">
        <span class="view-title">
          <span class="view-name" dir="auto">
            {name()}
          </span>
          <span class="view-meta">
            {formatBytes(size())}
            {languageFor(name()) !== null && !isMarkdown() ? ` · ${languageFor(name())}` : ''}
          </span>
        </span>
        <span class="toolbar-spacer" />
        <Show when={isMarkdown()}>
          <Segmented
            small
            value={mode()}
            label="Show"
            options={[
              { value: 'preview', label: 'Preview' },
              { value: 'source', label: 'Source' },
            ]}
            onChange={(v) => setMode(v as 'preview' | 'source')}
          />
        </Show>
        <Show when={!isMarkdown() || mode() === 'source'}>
          <IconButton
            icon="wrap-text"
            label={wrap() ? 'Long lines: wrapped (W)' : 'Long lines: scroll (W)'}
            active={wrap()}
            onClick={() =>
              setWrap((w) => {
                setSetting('textWrap', !w)
                return !w
              })
            }
          />
        </Show>
        <Show when={file()}>
          {(read) => (
            <Button
              small
              kind="ghost"
              icon="languages"
              class="tv-encoding"
              title={`Text encoding: ${encodingLabel(read().encoding)}${
                read().confident || chosen() !== null ? '' : ' (a guess)'
              }`}
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setEncodingMenu({ x: r.right, y: r.bottom + 4 })
              }}
            >
              {encodingShort(read().encoding)}
            </Button>
          )}
        </Show>
        <IconButton icon="zoom-out" label="Smaller text (Ctrl+−)" onClick={() => stepFont(-1)} />
        <IconButton icon="zoom-in" label="Larger text (Ctrl++)" onClick={() => stepFont(1)} />
      </Toolbar>
      <Switch>
        <Match when={file.error !== undefined}>
          <div class="view-center">
            <EmptyState icon="circle-alert" title={`Could not read ${name()}`} warning />
          </div>
        </Match>
        <Match when={file.loading && file() === undefined}>
          <div class="view-center tv-message">Loading…</div>
        </Match>
        <Match when={text() !== undefined}>
          <Show
            when={isMarkdown() && mode() === 'preview'}
            fallback={
              <div
                class="tv-code"
                classList={{ 'tv-code--wrap': wrap() }}
                ref={(el) => {
                  scroller = el
                }}
                onScroll={onScroll}
              >
                <pre class="tv-gutter" aria-hidden="true">
                  {lineNumbers()}
                </pre>
                <pre class="tv-source hljs">
                  <code ref={(el) => createEffect(() => setHtml(el, highlighted()))} />
                </pre>
              </div>
            }
          >
            <article
              class="tv-markdown"
              ref={(el) => {
                scroller = el
                createEffect(() => setHtml(el, markdownHtml()))
              }}
              onClick={onLink}
              onScroll={onScroll}
            />
          </Show>
          <Show when={truncated()}>
            <div class="tv-note">Showing the first 2 MB of {formatBytes(size())}.</div>
          </Show>
        </Match>
      </Switch>
      <Show when={encodingMenu()}>
        {(at) => <Menu items={encodingItems()} at={at()} onClose={() => setEncodingMenu(null)} />}
      </Show>
    </div>
  )
}
