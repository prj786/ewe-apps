import { describe, expect, it } from 'vitest'
import { columnName, guessDelimiter, parseCsv } from './csv'

describe('csv', () => {
  it('parses plain rows and a trailing newline', () => {
    const t = parseCsv('a,b,c\n1,2,3\n')
    expect(t.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
    expect(t.columns).toBe(3)
    expect(t.delimiter).toBe(',')
  })

  it('handles quotes, doubled quotes and newlines inside quotes', () => {
    const t = parseCsv('name,note\n"Smith, John","said ""hi""\nthen left"\n')
    expect(t.rows).toEqual([
      ['name', 'note'],
      ['Smith, John', 'said "hi"\nthen left'],
    ])
  })

  it('accepts CRLF, lone CR and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r3,4').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('keeps empty fields and ragged rows', () => {
    const t = parseCsv('a,,c\n1\n,,\n')
    expect(t.rows).toEqual([['a', '', 'c'], ['1'], ['', '', '']])
    expect(t.columns).toBe(3)
  })

  it('guesses semicolons, tabs and pipes', () => {
    expect(guessDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(guessDelimiter('a\tb\n1\t2')).toBe('\t')
    expect(guessDelimiter('a|b\n1|2')).toBe('|')
    // the comma inside quotes does not count
    expect(guessDelimiter('"x, y";b\n1;2')).toBe(';')
    expect(guessDelimiter('')).toBe(',')
    expect(guessDelimiter('just one column\nanother')).toBe(',')
    expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t')
    // German-style numbers with a decimal comma and semicolon separators
    expect(parseCsv('x;y\n1,5;2,5').rows).toEqual([
      ['x', 'y'],
      ['1,5', '2,5'],
    ])
  })

  it('empty input is no rows', () => {
    expect(parseCsv('').rows).toEqual([])
    expect(parseCsv('\n').rows).toEqual([['']])
  })

  it('names columns like a spreadsheet', () => {
    expect(columnName(0)).toBe('A')
    expect(columnName(25)).toBe('Z')
    expect(columnName(26)).toBe('AA')
    expect(columnName(27)).toBe('AB')
    expect(columnName(51)).toBe('AZ')
    expect(columnName(52)).toBe('BA')
    expect(columnName(701)).toBe('ZZ')
    expect(columnName(702)).toBe('AAA')
  })
})
