import type { PercentCrop } from 'react-image-crop'
import type { CropBox } from './types'

/** Keep original-image pixels independent of display size and zoom. */
export function cropFromPercent(crop: PercentCrop, width: number, height: number): CropBox {
  const left = Math.max(0, Math.min(width, Math.round((crop.x * width) / 100)))
  const top = Math.max(0, Math.min(height, Math.round((crop.y * height) / 100)))
  const right = Math.min(width, Math.round(((crop.x + crop.width) * width) / 100))
  const bottom = Math.min(height, Math.round(((crop.y + crop.height) * height) / 100))
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}
export function cropToPercent(crop: CropBox, width: number, height: number): PercentCrop {
  return {
    unit: '%',
    x: (crop.left / width) * 100,
    y: (crop.top / height) * 100,
    width: (crop.width / width) * 100,
    height: (crop.height / height) * 100,
  }
}
export function editableCrop(box: CropBox, imageWidth: number, imageHeight: number): CropBox {
  const width = Math.min(imageWidth, Math.max(8, box.width))
  const height = Math.min(imageHeight, Math.max(8, box.height))
  return {
    left: Math.max(0, Math.min(imageWidth - width, box.left - Math.floor((width - box.width) / 2))),
    top: Math.max(
      0,
      Math.min(imageHeight - height, box.top - Math.floor((height - box.height) / 2)),
    ),
    width,
    height,
  }
}
