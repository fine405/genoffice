import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createPickerSession } from '../src/service'

function backend(tamper = false) {
  const bytes = new Uint8Array([0, 1, 0, 0, 4, 5, 6])
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    if (path.endsWith('/images'))
      return Response.json({ image_id: 'image-a', input_image: { width: 200, height: 100 } })
    if (path.endsWith('/images/image-a/file')) return new Response(bytes)
    if (path.endsWith('/scans'))
      return Response.json({ regions: [{ font_matches: [{ fonts: [{ font_id: 'font-a' }] }] }] })
    if (path.endsWith('/fonts/font-a'))
      return Response.json({
        font_id: 'font-a',
        size_bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    if (path.endsWith('/fonts/font-a/file'))
      return new Response(tamper ? new Uint8Array([0, 0, 0, 0, 0, 0, 0]) : bytes)
    throw new Error('Unexpected request: ' + path)
  })
  return {
    fetch,
    session: createPickerSession({
      baseUrl: 'https://fonts.test/api/v1',
      apiKey: 'test-key',
      fetch,
    }),
  }
}

describe('font picker service boundary', () => {
  it('aborts pending recognition when the dialog closes and cleans up its image', async () => {
    const { session, fetch } = backend()
    const image = await session.upload(new Uint8Array([1]))
    fetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          })
        }),
    )
    const pending = expect(session.scan(image.id, null)).rejects.toThrow()
    await session.dispose()
    await pending
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
  })
  it('rejects unowned images and unknown fonts without network requests', async () => {
    const { session, fetch } = backend()
    await expect(session.scan('other-project-image', null)).rejects.toThrow('Upload')
    await expect(session.font('other-font')).rejects.toThrow('Choose')
    await expect(session.upload(new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow('10 MB')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('uses normalized originals, forwards crop, deduplicates verified fonts and deletes uploads', async () => {
    const { session, fetch } = backend()
    const image = await session.upload(new Uint8Array([1, 2, 3]))
    expect(image).toMatchObject({ id: 'image-a', width: 200, height: 100 })
    expect(image.dataUrl).toMatch(/^data:image\/png;base64,/)
    const crop = { left: 10, top: 20, width: 80, height: 30 }
    await session.scan(image.id, crop)
    const scan = fetch.mock.calls.find(([url]) => String(url).endsWith('/scans'))!
    expect(JSON.parse(String(scan[1]?.body))).toMatchObject({ image_id: 'image-a', crop_box: crop })
    const [a, b] = await Promise.all([session.font('font-a'), session.font('font-a')])
    expect(a).toEqual(b)
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith('/fonts/font-a/file')),
    ).toHaveLength(1)
    expect(new Headers(scan[1]?.headers).get('Authorization')).toBe('Bearer test-key')
    await session.dispose()
    expect(
      fetch.mock.calls.some(
        ([url, init]) => String(url).endsWith('/images/image-a') && init?.method === 'DELETE',
      ),
    ).toBe(true)
  })
  it('rejects corrupt font downloads and allows a later retry', async () => {
    const { session, fetch } = backend(true)
    const image = await session.upload(new Uint8Array([1]))
    await session.scan(image.id, null)
    await expect(session.font('font-a')).rejects.toThrow('checksum')
    await expect(session.font('font-a')).rejects.toThrow('checksum')
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith('/fonts/font-a/file')),
    ).toHaveLength(2)
    await session.dispose()
  })
})
