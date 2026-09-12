import type { CropBox } from './types'
export interface Point {
  x: number
  y: number
}

/** Pointer positions are fractions of the displayed original, independent of zoom. */
export function imagePoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): Point {
  return {
    x: Math.max(0, Math.min(1, (x - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (y - rect.top) / rect.height)),
  }
}
export function cropFromPoints(a: Point, b: Point, width: number, height: number): CropBox | null {
  const left = Math.round(Math.min(a.x, b.x) * width)
  const top = Math.round(Math.min(a.y, b.y) * height)
  const right = Math.min(width, Math.round(Math.max(a.x, b.x) * width))
  const bottom = Math.min(height, Math.round(Math.max(a.y, b.y) * height))
  return right - left >= 8 && bottom - top >= 8
    ? { left, top, width: right - left, height: bottom - top }
    : null
}
