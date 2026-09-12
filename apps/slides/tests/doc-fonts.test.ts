import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const loadFace = vi.fn()
const fontData = vi.fn()
beforeEach(() => {
  vi.resetModules()
  loadFace.mockReset().mockResolvedValue(undefined)
  fontData.mockReset().mockResolvedValue(new ArrayBuffer(4))
  vi.stubGlobal(
    'FontFace',
    class {
      load = loadFace
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: vi.fn(), delete: vi.fn(), dispatchEvent: vi.fn() },
  })
  window.slidesApi = {
    privateFontFaces: vi
      .fn()
      .mockResolvedValue([{ id: 'font-1', family: 'Test Font', bold: false, italic: false }]),
    privateFontData: fontData,
  } as unknown as typeof window.slidesApi
})
afterEach(() => vi.unstubAllGlobals())

it('concurrent syncs wait for the same font load before reporting readiness', async () => {
  let finish!: () => void
  loadFace.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const { syncPrivateFonts } = await import('../src/renderer/doc-fonts')
  const first = syncPrivateFonts('Test Font')
  await vi.waitFor(() => expect(loadFace).toHaveBeenCalledOnce())
  let ready = false
  const second = syncPrivateFonts('Test Font').then(() => {
    ready = true
  })
  await Promise.resolve()
  expect(ready).toBe(false)
  expect(fontData).toHaveBeenCalledOnce()
  finish()
  await Promise.all([first, second])
  expect(ready).toBe(true)
  expect(window.__genofficeDocFontsSynced).toBe(true)
})

it('failed registration reports an error and can be retried', async () => {
  const { syncPrivateFonts } = await import('../src/renderer/doc-fonts')
  loadFace.mockRejectedValueOnce(new Error('Failed to parse'))
  await expect(syncPrivateFonts('Test Font')).rejects.toThrow('could not be loaded')
  await expect(syncPrivateFonts('Test Font')).resolves.toBeUndefined()
  expect(fontData).toHaveBeenCalledTimes(2)
  expect(document.fonts.add).toHaveBeenCalledOnce()
})
