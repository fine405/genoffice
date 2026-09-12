import { createHash } from 'node:crypto'
import { createFontClient, type ClientOptions, type CropBox } from '@lens/sdk'
import type { FontFile, FontProgress, PickerImage } from './types'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_FONT_BYTES = 32 * 1024 * 1024

/** One dialog owns its uploads and candidates; callers cannot fetch arbitrary service resources. */
export function createPickerSession(
  options: ClientOptions,
  onProgress?: (progress: FontProgress) => void,
) {
  const client = createFontClient(options)
  const controller = new AbortController()
  const images = new Set<string>()
  const candidates = new Set<string>()
  const files = new Map<string, Promise<FontFile>>()
  const opts = { signal: controller.signal }
  async function font(fontId: string): Promise<FontFile> {
    if (!candidates.has(fontId))
      throw new Error('Choose a font from the recognition results first.')
    const cached = files.get(fontId)
    if (cached) return cached
    const request = (async () => {
      onProgress?.({ fontId, phase: 'preparing', received: 0 })
      const detail = await client.font(fontId, opts)
      if (
        !Number.isInteger(detail.size_bytes) ||
        detail.size_bytes <= 0 ||
        detail.size_bytes > MAX_FONT_BYTES
      ) {
        throw new Error('Font file exceeds the supported size.')
      }
      const response = await client.fontFile(fontId, opts)
      onProgress?.({ fontId, phase: 'downloading', received: 0, total: detail.size_bytes })
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Empty font response.')
      const chunks: Uint8Array[] = []
      let length = 0
      let lastPercent = -1
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          length += value.length
          if (length > MAX_FONT_BYTES || length > detail.size_bytes)
            throw new Error('Invalid font file size.')
          chunks.push(value)
          const percent = Math.floor((length / detail.size_bytes) * 100)
          if (percent !== lastPercent) {
            onProgress?.({
              fontId,
              phase: 'downloading',
              received: length,
              total: detail.size_bytes,
            })
            lastPercent = percent
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      const bytes = Buffer.concat(chunks)
      onProgress?.({ fontId, phase: 'verifying', received: length, total: detail.size_bytes })
      if (
        length !== detail.size_bytes ||
        createHash('sha256').update(bytes).digest('hex') !== detail.sha256
      ) {
        throw new Error('Font download failed its checksum check.')
      }
      return { font: detail, bytes: new Uint8Array(bytes) }
    })()
    files.set(fontId, request)
    try {
      return await request
    } catch (error) {
      files.delete(fontId)
      throw error
    }
  }
  return {
    async upload(bytes: Uint8Array): Promise<PickerImage> {
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) {
        throw new Error('Choose a PNG, JPEG or WebP image smaller than 10 MB.')
      }
      const image = await client.upload(new Blob([new Uint8Array(bytes)]), opts)
      images.add(image.image_id)
      if (controller.signal.aborted) {
        await client.deleteImage(image.image_id).catch(() => {})
        controller.signal.throwIfAborted()
      }
      const normalized = Buffer.from(
        await (await client.imageFile(image.image_id, opts)).arrayBuffer(),
      )
      return {
        id: image.image_id,
        width: image.input_image.width,
        height: image.input_image.height,
        dataUrl: `data:image/png;base64,${normalized.toString('base64')}`,
      }
    },
    async scan(imageId: string, crop: CropBox | null) {
      if (!images.has(imageId)) throw new Error('Upload an image before scanning.')
      const result = await client.scan({ imageId }, { ...opts, cropBox: crop, topK: 3 })
      for (const region of result.regions)
        for (const match of region.font_matches) {
          for (const variant of match.fonts) candidates.add(variant.font_id)
        }
      return result
    },
    font,
    async dispose() {
      controller.abort()
      await Promise.allSettled([...images].map((id) => client.deleteImage(id)))
      images.clear()
      files.clear()
    },
  }
}
