// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageLabClient } from '@image-lab/client'
import { ImageLabJobs, imageLabClient, type ImageLabTarget } from '../src/main/image-lab'
import type { RenderSlide } from '@genoffice/pptx-render'

const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })
const source = 'data:image/png;base64,iVBORw0KGgo='
const result = { foreground: png, mask: png, metadata: {} }
const prepare = (requestId = 'one') => ({
  action: 'prepare' as const,
  requestId,
  slideIndex: 0,
  sourceId: 'picture',
})
function setup() {
  const client = new ImageLabClient({ baseUrl: 'http://127.0.0.1:7100', token: 'test' })
  vi.spyOn(client, 'capabilities').mockResolvedValue({})
  const remove = vi.spyOn(client, 'removeBackground').mockResolvedValue(result)
  const target: ImageLabTarget = {
    dataUrl: source,
    slideIndex: 0,
    isCurrent: () => true,
    apply: vi.fn(() => ({ nodes: [] }) as unknown as RenderSlide),
  }
  const jobs = new ImageLabJobs(() => client)
  const request = (r: Parameters<ImageLabJobs['request']>[1], owner = 1) =>
    jobs.request(owner, r, () => target, vi.fn())
  return { jobs, request, target, remove }
}
afterEach(() => vi.unstubAllEnvs())
describe('Image Lab job lifecycle', () => {
  it('previews without changing the document and applies the same bytes once', async () => {
    const { request, target, remove } = setup()
    expect(await request(prepare())).toMatchObject({ ok: true, preview: source })
    expect(target.apply).not.toHaveBeenCalled()
    expect(await request({ action: 'apply', requestId: 'one' })).toMatchObject({
      ok: true,
      slideIndex: 0,
    })
    expect(target.apply).toHaveBeenCalledWith(new Uint8Array(await png.arrayBuffer()))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(await request({ action: 'apply', requestId: 'one' })).toMatchObject({ ok: false })
  })
  it('rejects a changed picture and another document owner', async () => {
    const { request, target } = setup()
    await request(prepare())
    expect(await request({ action: 'apply', requestId: 'one' }, 2)).toMatchObject({ ok: false })
    target.isCurrent = () => false
    expect(await request({ action: 'apply', requestId: 'one' })).toMatchObject({ ok: false })
    expect(target.apply).not.toHaveBeenCalled()
  })
  it('discards late results after cancellation, even if the service ignores abort', async () => {
    const { request, target, remove } = setup()
    let finish!: (value: typeof result) => void
    remove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = request(prepare())
    await vi.waitFor(() => expect(remove).toHaveBeenCalled())
    await request({ action: 'cancel', requestId: 'one' })
    finish(result)
    expect(await pending).toMatchObject({ ok: false })
    expect(await request({ action: 'apply', requestId: 'one' })).toMatchObject({ ok: false })
    expect(target.apply).not.toHaveBeenCalled()
  })
  it('an old cancel cannot cancel the replacement request', async () => {
    const { request } = setup()
    await request(prepare('one'))
    await request(prepare('two'))
    await request({ action: 'cancel', requestId: 'one' })
    expect(await request({ action: 'apply', requestId: 'two' })).toMatchObject({ ok: true })
  })
  it('rejects unsupported input before connecting', async () => {
    const { request, target, remove } = setup()
    target.dataUrl = 'data:image/svg+xml;base64,AAAA'
    expect(await request(prepare())).toMatchObject({ ok: false })
    expect(remove).not.toHaveBeenCalled()
  })
  it('requires credentials and prevents sending them over remote plain HTTP', () => {
    vi.stubEnv('GENOFFICE_IMAGE_LAB_TOKEN', '')
    vi.stubEnv('GENOFFICE_IMAGE_LAB_TOKEN_FILE', '')
    expect(() => imageLabClient()).toThrow('TOKEN_FILE')
    vi.stubEnv('GENOFFICE_IMAGE_LAB_URL', 'http://example.com')
    expect(() => imageLabClient()).toThrow('Invalid')
  })
})
