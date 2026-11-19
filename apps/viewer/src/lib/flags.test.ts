import { describe, expect, it } from 'vitest'
import { fillFlags, flagNumber, flagValue, hasFlag } from './flags'

describe('launch flags', () => {
  it('reads --key=value and bare flags', () => {
    const flags = ['--page=12', '--night', '--find=sheep dog', '--mode=two']
    expect(flagValue(flags, 'page')).toBe('12')
    expect(flagNumber(flags, 'page')).toBe(12)
    expect(flagValue(flags, 'night')).toBe('')
    expect(hasFlag(flags, 'night')).toBe(true)
    expect(hasFlag(flags, 'day')).toBe(false)
    expect(flagValue(flags, 'find')).toBe('sheep dog')
    expect(flagNumber(flags, 'mode')).toBeNull()
    expect(flagValue([], 'page')).toBeNull()
  })

  it('collects --fill pairs', () => {
    expect(
      fillFlags(['--fill=name=Dolly Baa', '--fill=shorn=Yes', '--fill=broken', '--page=2']),
    ).toEqual({
      name: 'Dolly Baa',
      shorn: 'Yes',
    })
  })
})
