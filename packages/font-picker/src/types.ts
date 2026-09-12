import type { CropBox, FontDetails, ScanResult } from '@lens/sdk'
export type { CropBox, FontDetails, FontMatch, FontVariant, Region, ScanResult } from '@lens/sdk'

export interface PickerImage {
  id: string
  dataUrl: string
  width: number
  height: number
}
export interface FontFile {
  font: FontDetails
  bytes: Uint8Array
}
export interface FontProgress {
  fontId: string
  phase: 'preparing' | 'downloading' | 'verifying'
  received: number
  total?: number
}
export type PickerRequest =
  | { action: 'upload'; bytes: Uint8Array }
  | { action: 'scan'; imageId: string; crop: CropBox | null }
  | { action: 'font'; fontId: string }
  | { action: 'install'; fontId: string }
  | { action: 'download'; fontId: string }
  | { action: 'dispose' }
export type PickerResult<T> = { ok: true; value: T } | { ok: false; error: string }
export interface FontPickerApi {
  onFontProgress?(handler: (progress: FontProgress) => void): () => void
  upload(bytes: Uint8Array): Promise<PickerImage>
  scan(imageId: string, crop: CropBox | null): Promise<ScanResult>
  font(fontId: string): Promise<FontFile>
  install(fontId: string): Promise<string>
  download(fontId: string): Promise<boolean>
  dispose(): Promise<void>
}
export interface DocumentImage {
  id: string
  label: string
  dataUrl: string
}
