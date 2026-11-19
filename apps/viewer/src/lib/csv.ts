// CSV / TSV reading for the table view. RFC 4180 quoting (doubled quotes, newlines
// inside quotes), CRLF and lone CR line ends, a UTF-8 BOM, and the delimiter guessed
// from the first lines when the caller does not know it.

export type Delimiter = ',' | ';' | '\t' | '|'

export interface Table {
  rows: string[][]
  delimiter: Delimiter
  /** the widest row */
  columns: number
}

const CANDIDATES: Delimiter[] = [',', ';', '\t', '|']

/**
 * Pick the delimiter whose count is the same on most of the first rows (and highest
 * when tied). Quoted sections are skipped while counting.
 */
export function guessDelimiter(text: string, sampleLines = 20): Delimiter {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '')
    .slice(0, sampleLines)
  if (lines.length === 0) return ','
  let best: Delimiter = ','
  let bestScore = -1
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, d))
    const first = counts[0] ?? 0
    if (first === 0) continue
    const consistent = counts.filter((c) => c === first).length
    const score = consistent * 1000 + first
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === d && !quoted) n++
  }
  return n
}

export function parseCsv(text: string, delimiter?: Delimiter): Table {
  if (text.startsWith('﻿')) text = text.slice(1)
  const d = delimiter ?? guessDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text.charAt(i)
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      quoted = true
      i++
      continue
    }
    if (ch === d) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i++
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // a trailing newline leaves nothing behind; an empty file is no rows
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return { rows, delimiter: d, columns }
}

/** Spreadsheet-style column names: A…Z, AA…AZ, BA… */
export function columnName(index: number): string {
  let s = ''
  let n = index
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}
