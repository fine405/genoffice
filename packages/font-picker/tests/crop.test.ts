import { describe, expect, it } from 'vitest'
import { cropFromPercent, cropToPercent, editableCrop } from '../src/crop'

describe('Font Lab original-image crop coordinates', () => {
  it('roundtrips fractional screen coordinates without changing the source pixels', () => {
    const crop = { left: 205, top: 205, width: 512, height: 512 }
    expect(cropFromPercent(cropToPercent(crop, 1024, 1024), 1024, 1024)).toEqual(crop)
    expect(cropFromPercent({ unit: '%', x: 25, y: 50, width: 25, height: 20 }, 1600, 800)).toEqual({
      left: 400,
      top: 400,
      width: 400,
      height: 160,
    })
  })
  it('clamps selections to the image and keeps tiny drafts visible for adjustment', () => {
    expect(cropFromPercent({ unit: '%', x: 90, y: 90, width: 50, height: 50 }, 100, 100)).toEqual({
      left: 90,
      top: 90,
      width: 10,
      height: 10,
    })
    expect(cropFromPercent({ unit: '%', x: 0, y: 0, width: 1, height: 1 }, 100, 100)).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 1,
    })
  })
  it('expands narrow OCR regions into editable crops inside the image', () => {
    expect(editableCrop({ left: 99, top: 0, width: 1, height: 2 }, 100, 100)).toEqual({
      left: 92,
      top: 0,
      width: 8,
      height: 8,
    })
  })
})
