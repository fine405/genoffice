import type { RenderSlide } from '@genoffice/pptx-render'

export type ImageLabRequest =
  | { action: 'prepare'; requestId: string; slideIndex: number; sourceId: string }
  | { action: 'apply' | 'cancel'; requestId: string }
export interface ImageLabProgress {
  requestId: string
  stage: string
}
export type ImageLabResult =
  | { ok: true; preview?: string; slide?: RenderSlide; slideIndex?: number }
  | { ok: false; error: string }
