/** Image Lab jobs stay in the main process, including credentials and final PNG bytes. */
import { readFileSync } from 'node:fs'
import { ImageLabClient, ImageLabError } from '@image-lab/client'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { ImageLabProgress, ImageLabRequest, ImageLabResult } from '../shared/image-lab'

export interface ImageLabTarget {
  dataUrl: string
  slideIndex: number
  isCurrent: () => boolean
  apply: (bytes: Uint8Array) => RenderSlide | null
}
interface Task {
  id: string
  controller: AbortController
  target: ImageLabTarget
  bytes?: Uint8Array
}

export function imageLabClient(): ImageLabClient {
  const baseUrl = process.env.GENOFFICE_IMAGE_LAB_URL || 'http://127.0.0.1:7100'
  const url = new URL(baseUrl)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
  )
    throw new Error('Invalid Image Lab service URL.')
  let token = process.env.GENOFFICE_IMAGE_LAB_TOKEN?.trim()
  if (!token && process.env.GENOFFICE_IMAGE_LAB_TOKEN_FILE) {
    try {
      token = readFileSync(process.env.GENOFFICE_IMAGE_LAB_TOKEN_FILE, 'utf8').trim()
    } catch {
      throw new Error('Cannot read GENOFFICE_IMAGE_LAB_TOKEN_FILE.')
    }
  }
  if (!token) throw new Error('Start Image Lab and configure GENOFFICE_IMAGE_LAB_TOKEN_FILE.')
  return new ImageLabClient({ baseUrl, token })
}

export class ImageLabJobs {
  private tasks = new Map<number, Task>()
  constructor(private client = imageLabClient) {}

  cancel(owner: number, id?: string): void {
    const task = this.tasks.get(owner)
    if (!task || (id && task.id !== id)) return
    this.tasks.delete(owner)
    task.controller.abort()
  }

  async request(
    owner: number,
    request: ImageLabRequest,
    capture: (slideIndex: number, sourceId: string) => ImageLabTarget,
    progress: (value: ImageLabProgress) => void,
  ): Promise<ImageLabResult> {
    try {
      if (!request || typeof request.requestId !== 'string' || !request.requestId) {
        throw new Error('Invalid image processing request.')
      }
      if (request.action === 'cancel') {
        this.cancel(owner, request.requestId)
        return { ok: true }
      }
      if (request.action === 'apply') {
        const task = this.tasks.get(owner)
        if (!task || task.id !== request.requestId || !task.bytes)
          throw new Error('Result expired. Please try again.')
        this.tasks.delete(owner)
        if (!task.target.isCurrent())
          throw new Error('The original picture changed. Please reopen background removal.')
        const slide = task.target.apply(task.bytes)
        if (!slide) throw new Error('Could not update the picture.')
        return { ok: true, slide, slideIndex: task.target.slideIndex }
      }
      if (request.action !== 'prepare') throw new Error('Invalid image processing action.')
      this.cancel(owner)
      const target = capture(request.slideIndex, request.sourceId)
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/.exec(target.dataUrl)
      if (!match) throw new Error('Choose a PNG, JPEG or WebP picture.')
      const source = Buffer.from(match[2]!, 'base64')
      if (!source.length || source.length > 20 * 1024 * 1024)
        throw new Error('Image Lab accepts pictures up to 20 MB.')
      const task: Task = { id: request.requestId, controller: new AbortController(), target }
      this.tasks.set(owner, task)
      try {
        progress({ requestId: task.id, stage: 'connecting' })
        const client = this.client()
        await client.capabilities(
          AbortSignal.any([task.controller.signal, AbortSignal.timeout(30_000)]),
        )
        const result = await client.removeBackground(new Blob([source], { type: match[1] }), {
          signal: task.controller.signal,
          onStatus: (job) =>
            progress({
              requestId: task.id,
              stage: job.state === 'succeeded' ? 'downloading' : job.stage || job.state,
            }),
        })
        const bytes = new Uint8Array(await result.foreground.arrayBuffer())
        if (this.tasks.get(owner) !== task || task.controller.signal.aborted)
          throw new Error('Processing cancelled.')
        if (!target.isCurrent())
          throw new Error('The original picture changed. Please reopen background removal.')
        if (
          result.foreground.type !== 'image/png' ||
          !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ) {
          throw new Error('Image Lab returned an invalid PNG.')
        }
        task.bytes = bytes
        return {
          ok: true,
          preview: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
        }
      } catch (error) {
        if (this.tasks.get(owner) === task) this.cancel(owner)
        throw error
      }
    } catch (error) {
      // Do not expose service response bodies or credentials to the renderer.
      const message =
        error instanceof ImageLabError
          ? `Image Lab: ${error.code}. Please retry.`
          : error instanceof TypeError
            ? 'Cannot connect to Image Lab. Check that the service is running.'
            : error instanceof Error
              ? error.message
              : 'Background removal failed.'
      return { ok: false, error: message }
    }
  }
}
