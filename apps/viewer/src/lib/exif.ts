// The core's ExifInfo → the rows the picture info panel shows, in plain words.

export interface ExifInfo {
  date: string | null
  make: string | null
  model: string | null
  lens: string | null
  exposure: string | null
  fNumber: number | null
  iso: number | null
  focalLength: number | null
  focalLength35mm: number | null
  width: number | null
  height: number | null
  orientation: number | null
  software: string | null
  latitude: number | null
  longitude: number | null
}

export interface InfoRow {
  label: string
  value: string
}

/** "Canon EOS R6" when the model already names the maker, else "Maker Model". */
export function cameraName(make: string | null, model: string | null): string | null {
  const m = model?.trim() ?? ''
  const mk = make?.trim() ?? ''
  if (m === '' && mk === '') return null
  if (m === '') return mk
  if (mk === '') return m
  const firstWord = mk.split(/\s+/)[0] ?? mk
  if (m.toLowerCase().includes(firstWord.toLowerCase())) return m
  return `${mk} ${m}`
}

export function exposureLine(info: ExifInfo): string | null {
  const parts: string[] = []
  if (info.exposure !== null) parts.push(`${info.exposure} s`)
  if (info.fNumber !== null) parts.push(`f/${trimNumber(info.fNumber)}`)
  if (info.iso !== null) parts.push(`ISO ${info.iso}`)
  return parts.length === 0 ? null : parts.join(' · ')
}

export function focalLine(info: ExifInfo): string | null {
  if (info.focalLength === null) return null
  const f = `${trimNumber(info.focalLength)} mm`
  if (info.focalLength35mm !== null && info.focalLength35mm !== Math.round(info.focalLength))
    return `${f} (${info.focalLength35mm} mm equivalent)`
  return f
}

function trimNumber(n: number): string {
  return String(Math.round(n * 10) / 10)
}

/** "2024-05-01 12:30:45" → the user's locale, date and time. */
export function exifDate(date: string | null): string | null {
  if (date === null) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(date)
  if (m === null) return date
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  )
  if (Number.isNaN(d.getTime())) return date
  return d.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
}

export function coordinates(lat: number | null, lon: number | null): string | null {
  if (lat === null || lon === null) return null
  const f = (v: number, pos: string, neg: string) =>
    `${Math.abs(v).toFixed(5)}° ${v >= 0 ? pos : neg}`
  return `${f(lat, 'N', 'S')}, ${f(lon, 'E', 'W')}`
}

export function exifRows(info: ExifInfo | null): InfoRow[] {
  if (info === null) return []
  const rows: InfoRow[] = []
  const push = (label: string, value: string | null) => {
    if (value !== null && value !== '') rows.push({ label, value })
  }
  push('Taken', exifDate(info.date))
  push('Camera', cameraName(info.make, info.model))
  push('Lens', info.lens)
  push('Exposure', exposureLine(info))
  push('Focal length', focalLine(info))
  push('Location', coordinates(info.latitude, info.longitude))
  push('Software', info.software)
  return rows
}
