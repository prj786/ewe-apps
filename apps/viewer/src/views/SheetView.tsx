// Spreadsheets (XLSX / XLSM / XLS / ODS through SheetJS) and CSV / TSV (own parser):
// a read-only grid with a frozen header row and column letters, one tab per sheet.

import { For, Show, createMemo, createResource, createSignal, type JSX } from 'solid-js'
import { formatBytes, rawUrl, readText } from '@ewe/shared'
import { EmptyState, IconButton, ProgressBar, Segmented, Tabs, Toolbar, addRecent } from '@ewe/ui'
import { fileStat } from '../lib/bridge'
import { columnName, parseCsv } from '../lib/csv'
import { inTextInput, isMod, useKeys } from '../lib/keys'
import { baseName, docKind } from '../lib/kinds'
import { getSetting, setSetting } from '../lib/store'
import { flagNumber } from '../lib/flags'
import type { ViewProps } from './types'

interface Sheet {
  name: string
  rows: string[][]
  columns: number
}

const MAX_ROWS = 5000
const MAX_COLS = 256

export function SheetView(props: ViewProps): JSX.Element {
  const [sheet, setSheet] = createSignal(
    Math.max(0, (flagNumber(props.flags ?? [], 'sheet') ?? 1) - 1),
  )
  const [headerRow, setHeaderRow] = createSignal(getSetting('sheetHeader', true))
  const [size, setSize] = createSignal(0)
  const [wrap, setWrap] = createSignal(false)
  const isCsv = () => docKind(props.path) === 'csv'

  const [sheets] = createResource(
    () => props.path,
    async (path): Promise<Sheet[]> => {
      const stat = await fileStat(path)
      setSize(stat.size)
      if (isCsv()) {
        // CSV from Excel is often in the system's legacy code page: the core decodes it
        const { text } = await readText(props.server, path, { max: 32 * 1024 * 1024 })
        void addRecent(path).catch(() => undefined)
        const table = parseCsv(text, path.toLowerCase().endsWith('.tsv') ? '\t' : undefined)
        return [{ name: baseName(path), rows: table.rows, columns: table.columns }]
      }
      const response = await fetch(rawUrl(props.server, path))
      if (!response.ok) throw new Error(`Could not read ${baseName(path)}`)
      void addRecent(path).catch(() => undefined)
      const XLSX = await import('xlsx')
      const buffer = await response.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array', dense: true, cellDates: true })
      return wb.SheetNames.map((name) => {
        const ws = wb.Sheets[name]
        const grid = (ws as { '!data'?: unknown[][] } | undefined)?.['!data'] ?? []
        const rows: string[][] = []
        let columns = 0
        for (const row of grid.slice(0, MAX_ROWS + 1)) {
          const cells: string[] = []
          const r = (row ?? []) as ({ w?: string; v?: unknown } | undefined)[]
          for (const cell of r.slice(0, MAX_COLS)) {
            if (cell === undefined) cells.push('')
            else if (cell.w !== undefined) cells.push(cell.w)
            else if (cell.v instanceof Date) cells.push(cell.v.toLocaleDateString())
            else if (
              typeof cell.v === 'string' ||
              typeof cell.v === 'number' ||
              typeof cell.v === 'boolean'
            )
              cells.push(String(cell.v))
            else cells.push('')
          }
          while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
          columns = Math.max(columns, cells.length)
          rows.push(cells)
        }
        while (rows.length > 0 && (rows[rows.length - 1]?.length ?? 0) === 0) rows.pop()
        return { name, rows, columns }
      })
    },
  )

  const current = createMemo((): Sheet | null => sheets()?.[sheet()] ?? null)
  const metaLine = () => {
    const s = current()
    return s === null
      ? formatBytes(size())
      : `${formatBytes(size())} · ${s.rows.length.toLocaleString()} rows × ${s.columns} columns`
  }
  const body = () => {
    const s = current()
    if (s === null) return []
    return headerRow() ? s.rows.slice(1, MAX_ROWS + 1) : s.rows.slice(0, MAX_ROWS)
  }
  const header = () => (headerRow() ? (current()?.rows[0] ?? []) : [])
  const truncated = () => (current()?.rows.length ?? 0) > MAX_ROWS + (headerRow() ? 1 : 0)

  useKeys(
    () => props.active,
    (e) => {
      if (isMod(e) || inTextInput(e)) return false
      const n = sheets()?.length ?? 0
      if (e.key === 'Tab' && n > 1) {
        setSheet((s) => (s + (e.shiftKey ? -1 : 1) + n) % n)
        return true
      }
      return false
    },
  )

  return (
    <div class="sh">
      <Toolbar label="Spreadsheet" class="view-toolbar">
        <span class="view-title">
          <span class="view-name" dir="auto">
            {baseName(props.path)}
          </span>
          <span class="view-meta">{metaLine()}</span>
        </span>
        <span class="toolbar-spacer" />
        <Segmented
          small
          value={headerRow() ? 'header' : 'plain'}
          label="First row"
          options={[
            { value: 'header', label: 'First row is the header' },
            { value: 'plain', label: 'Plain rows' },
          ]}
          onChange={(v) => {
            setHeaderRow(v === 'header')
            setSetting('sheetHeader', v === 'header')
          }}
        />
        <IconButton
          icon="wrap-text"
          label={wrap() ? 'Cells: wrapped' : 'Cells: one line'}
          active={wrap()}
          onClick={() => setWrap((w) => !w)}
        />
      </Toolbar>
      <Show when={(sheets()?.length ?? 0) > 1}>
        <Tabs
          class="sh-tabs"
          tabs={(sheets() ?? []).map((s, i) => ({ id: String(i), label: s.name }))}
          selected={String(sheet())}
          label="Sheets"
          onSelect={(id) => setSheet(Number(id))}
        />
      </Show>
      <Show when={sheets.loading}>
        <div class="view-loading">
          <ProgressBar value={null} label="Reading the table" />
        </div>
      </Show>
      <Show when={sheets.error !== undefined}>
        <div class="view-center">
          <EmptyState icon="file-spreadsheet" title="Could not read this table" warning>
            {sheets.error instanceof Error ? sheets.error.message : String(sheets.error)}
          </EmptyState>
        </div>
      </Show>
      <Show when={current()}>
        {(s) => (
          <div class="sh-scroll" classList={{ 'sh-scroll--wrap': wrap() }}>
            <Show
              when={s().rows.length > 0}
              fallback={
                <div class="view-center">
                  <EmptyState icon="file-spreadsheet" title="This sheet is empty" compact />
                </div>
              }
            >
              <table class="sh-grid">
                <thead>
                  <tr>
                    <th class="sh-corner" />
                    <For each={Array.from({ length: s().columns }, (_, i) => i)}>
                      {(i) => <th class="sh-col">{columnName(i)}</th>}
                    </For>
                  </tr>
                  <Show when={headerRow()}>
                    <tr class="sh-header">
                      <th class="sh-rownum">1</th>
                      <For each={Array.from({ length: s().columns }, (_, i) => i)}>
                        {(i) => <th>{header()[i] ?? ''}</th>}
                      </For>
                    </tr>
                  </Show>
                </thead>
                <tbody>
                  <For each={body()}>
                    {(row, r) => (
                      <tr>
                        <th class="sh-rownum">{r() + (headerRow() ? 2 : 1)}</th>
                        <For each={Array.from({ length: s().columns }, (_, i) => i)}>
                          {(i) => {
                            const v = row[i] ?? ''
                            return <td classList={{ 'sh-num': /^-?[\d.,]+%?$/.test(v) }}>{v}</td>
                          }}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
            <Show when={truncated()}>
              <div class="tv-note">Showing the first {MAX_ROWS.toLocaleString()} rows.</div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
