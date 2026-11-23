import { describe, expect, it } from 'vitest'
import { comboKey } from './keys'

describe('comboKey', () => {
  it('is the Latin letter, lower case, whatever Shift and Caps Lock say', () => {
    expect(comboKey({ key: 'c', code: 'KeyC' })).toBe('c')
    expect(comboKey({ key: 'C', code: 'KeyC' })).toBe('c')
  })

  it('is the letter printed on the key when the layout types another script', () => {
    // Georgian: the C key types ც; Russian: с (Cyrillic); Greek: ψ
    expect(comboKey({ key: 'ც', code: 'KeyC' })).toBe('c')
    expect(comboKey({ key: 'с', code: 'KeyC' })).toBe('c')
    expect(comboKey({ key: 'ψ', code: 'KeyC' })).toBe('c')
    expect(comboKey({ key: 'ვ', code: 'KeyV' })).toBe('v')
  })

  it('keeps the letters of a Latin layout that moved them', () => {
    // Dvorak: the physical C key types j
    expect(comboKey({ key: 'j', code: 'KeyC' })).toBe('j')
  })

  it('leaves every other key alone', () => {
    expect(comboKey({ key: 'ArrowLeft', code: 'ArrowLeft' })).toBe('ArrowLeft')
    expect(comboKey({ key: '=', code: 'Equal' })).toBe('=')
    expect(comboKey({ key: 'F5', code: 'F5' })).toBe('F5')
    expect(comboKey({ key: 'Dead', code: 'KeyE' })).toBe('Dead')
    expect(comboKey({ key: '1', code: 'Digit1' })).toBe('1')
  })
})
