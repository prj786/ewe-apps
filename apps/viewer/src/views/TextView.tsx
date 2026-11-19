// Markdown, plain text and code — ported from ewe Browser's files/textview.tsx:
// highlight.js core with 24 languages (colours mapped to Ewe tokens in app.css), marked +
// DOMPurify for Markdown (relative images rewritten to raw URLs), the first 2 MB of big
// files, plus a Source / Preview switch, wrap, and the scroll position remembered.

import {
  Match,
  Show,
  Switch,
  createEffect,
  createResource,
  createSignal,
  on,
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
import { extensionOf, formatBytes, rawUrl } from '@ewe/shared'
import { EmptyState, IconButton, Segmented, Toolbar, addRecent, toast } from '@ewe/ui'
import { fileStat, openExternal } from '../lib/bridge'
import { inTextInput, isMod, useKeys } from '../lib/keys'
import { baseName, dirName, docKind } from '../lib/kinds'
import { getSetting, recallPosition, savePosition, setSetting } from '../lib/store'
import { hasFlag } from '../lib/flags'
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
  let scroller: HTMLElement | undefined

  const [text] = createResource(
    () => props.path,
    async (path) => {
      const stat = await fileStat(path)
      setSize(stat.size)
      const response = await fetch(rawUrl(props.server, path), {
        headers: stat.size > MAX_BYTES ? { range: `bytes=0-${MAX_BYTES - 1}` } : {},
      })
      if (!response.ok) throw new Error(`Could not read ${baseName(path)}`)
      void addRecent(path).catch(() => undefined)
      const body = await response.text()
      const saved = await recallPosition(path)
      if (saved?.scroll !== undefined) {
        const frac = saved.scroll
        requestAnimationFrame(() => {
          if (scroller !== undefined)
            scroller.scrollTop = frac * (scroller.scrollHeight - scroller.clientHeight)
        })
      }
      return body
    },
  )

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
      if (node.tagName === 'A') {
        node.setAttribute('rel', 'noopener')
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
      props.onOpen(resolvePath(dirName(props.path), href.split('#')[0] ?? href))
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
          <span class="view-name">{name()}</span>
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
        <IconButton icon="zoom-out" label="Smaller text (Ctrl+−)" onClick={() => stepFont(-1)} />
        <IconButton icon="zoom-in" label="Larger text (Ctrl++)" onClick={() => stepFont(1)} />
      </Toolbar>
      <Switch>
        <Match when={text.error !== undefined}>
          <div class="view-center">
            <EmptyState icon="circle-alert" title={`Could not read ${name()}`} warning />
          </div>
        </Match>
        <Match when={text.loading}>
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
    </div>
  )
}
