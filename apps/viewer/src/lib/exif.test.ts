import { describe, expect, it } from 'vitest'
import {
  cameraName,
  coordinates,
  exifDate,
  exifRows,
  exposureLine,
  focalLine,
  type ExifInfo,
} from './exif'

const base: ExifInfo = {
  date: null,
  make: null,
  model: null,
  lens: null,
  exposure: null,
  fNumber: null,
  iso: null,
  focalLength: null,
  focalLength35mm: null,
  width: null,
  height: null,
  orientation: null,
  software: null,
  latitude: null,
  longitude: null,
}

describe('exif mapping', () => {
  it('names the camera without repeating the maker', () => {
    expect(cameraName('Canon', 'Canon EOS R6')).toBe('Canon EOS R6')
    expect(cameraName('NIKON CORPORATION', 'NIKON Z 6')).toBe('NIKON Z 6')
    expect(cameraName('Apple', 'iPhone 15 Pro')).toBe('Apple iPhone 15 Pro')
    expect(cameraName('SONY', null)).toBe('SONY')
    expect(cameraName(null, 'X100V')).toBe('X100V')
    expect(cameraName(null, null)).toBeNull()
    expect(cameraName('  ', '')).toBeNull()
  })

  it('writes exposure and focal length in words', () => {
    expect(exposureLine({ ...base, exposure: '1/250', fNumber: 1.8, iso: 400 })).toBe(
      '1/250 s · f/1.8 · ISO 400',
    )
    expect(exposureLine({ ...base, fNumber: 2 })).toBe('f/2')
    expect(exposureLine(base)).toBeNull()
    expect(focalLine({ ...base, focalLength: 50 })).toBe('50 mm')
    expect(focalLine({ ...base, focalLength: 6.86, focalLength35mm: 26 })).toBe(
      '6.9 mm (26 mm equivalent)',
    )
    expect(focalLine({ ...base, focalLength: 35, focalLength35mm: 35 })).toBe('35 mm')
    expect(focalLine(base)).toBeNull()
  })

  it('formats dates and coordinates', () => {
    const d = exifDate('2024-05-01 12:30:45')
    expect(d).not.toBeNull()
    expect(d).toContain('2024')
    expect(exifDate('garbage')).toBe('garbage')
    expect(exifDate(null)).toBeNull()
    expect(coordinates(48.85837, 2.294481)).toBe('48.85837° N, 2.29448° E')
    expect(coordinates(-33.8688, -151.2093)).toBe('33.86880° S, 151.20930° W')
    expect(coordinates(1, null)).toBeNull()
  })

  it('builds rows only for what is there', () => {
    expect(exifRows(null)).toEqual([])
    expect(exifRows(base)).toEqual([])
    const rows = exifRows({
      ...base,
      make: 'Canon',
      model: 'Canon EOS R6',
      lens: 'RF50mm F1.8 STM',
      exposure: '1/250',
      fNumber: 1.8,
      iso: 400,
      focalLength: 50,
      software: 'darktable 4.6',
    })
    expect(rows.map((r) => r.label)).toEqual([
      'Camera',
      'Lens',
      'Exposure',
      'Focal length',
      'Software',
    ])
    expect(rows[0]?.value).toBe('Canon EOS R6')
  })
})
