// `--key=value` launch flags a view may honour for the files given on that command line
// (a flag's value is never a separate token — see the core's launch.rs).

export function flagValue(flags: readonly string[], key: string): string | null {
  const prefix = `--${key}=`
  for (const f of flags) {
    if (f === `--${key}`) return ''
    if (f.startsWith(prefix)) return f.slice(prefix.length)
  }
  return null
}

export function flagNumber(flags: readonly string[], key: string): number | null {
  const v = flagValue(flags, key)
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const hasFlag = (flags: readonly string[], key: string): boolean =>
  flagValue(flags, key) !== null

/** Every `--fill=field=value` on the command line (prefilling a PDF form). */
export function fillFlags(flags: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of flags) {
    if (!f.startsWith('--fill=')) continue
    const body = f.slice('--fill='.length)
    const eq = body.indexOf('=')
    if (eq > 0) out[body.slice(0, eq)] = body.slice(eq + 1)
  }
  return out
}
