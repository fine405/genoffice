import { describe, expect, it } from 'vitest'
import { cropFromPoints, imagePoint } from '../src/crop'

describe('normalized-original crop coordinates', () => {
  it('is identical at different zoom levels and offsets', () => {
    const a = imagePoint(200, 120, { left: 100, top: 20, width: 400, height: 200 })
    const b = imagePoint(300, 160, { left: 100, top: 20, width: 400, height: 200 })
    expect(cropFromPoints(a, b, 1600, 800)).toEqual({
      left: 400,
      top: 400,
      width: 400,
      height: 160,
    })
    expect(
      cropFromPoints(
        imagePoint(300, 220, { left: 100, top: 20, width: 800, height: 400 }),
        imagePoint(500, 300, { left: 100, top: 20, width: 800, height: 400 }),
        1600,
        800,
      ),
    ).toEqual(cropFromPoints(a, b, 1600, 800))
  })
  it('supports reverse dragging and clamps pointer capture outside the image', () => {
    const a = imagePoint(999, -20, { left: 0, top: 0, width: 200, height: 100 })
    expect(cropFromPoints(a, { x: 0.2, y: 0.8 }, 200, 100)).toEqual({
      left: 40,
      top: 0,
      width: 160,
      height: 80,
    })
  })
  it('rejects accidental clicks and tiny selections', () => {
    expect(cropFromPoints({ x: 0, y: 0 }, { x: 0.07, y: 0.5 }, 100, 100)).toBeNull()
    expect(cropFromPoints({ x: 0, y: 0 }, { x: 0.08, y: 0.08 }, 100, 100)).toEqual({
      left: 0,
      top: 0,
      width: 8,
      height: 8,
    })
  })
})
