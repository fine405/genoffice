import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToastHost } from '../src/renderer/components/toast'
import { setToastEmitter, showToast } from '../src/renderer/components/toast-bus'
import { downloadCatalogFont } from '../src/renderer/font-manager'
import { syncPrivateFonts } from '../src/renderer/doc-fonts'

vi.mock('../src/renderer/doc-fonts', () => ({ syncPrivateFonts: vi.fn() }))
vi.mock('../src/renderer/i18n/locale', () => ({ getLang: () => 'en' }))

const notify = vi.fn()
beforeEach(() => {
  notify.mockReset()
  vi.mocked(syncPrivateFonts).mockReset().mockResolvedValue(undefined)
  window.slidesApi = {
    fontDownload: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as typeof window.slidesApi
  setToastEmitter(notify)
})
afterEach(() => {
  setToastEmitter(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('announces downloading and loading, and waits for font readiness before success', async () => {
  let finishDownload!: (value: { ok: boolean }) => void
  let finishLoading!: () => void
  vi.mocked(window.slidesApi.fontDownload).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishDownload = resolve
      }),
  )
  vi.mocked(syncPrivateFonts).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishLoading = resolve
      }),
  )
  const request = downloadCatalogFont('Example Font')
  expect(notify).toHaveBeenLastCalledWith({
    kind: 'loading',
    text: 'Example Font · Downloading font…',
  })
  finishDownload({ ok: true })
  await vi.waitFor(() => expect(syncPrivateFonts).toHaveBeenCalledWith('Example Font'))
  expect(notify).toHaveBeenLastCalledWith({ kind: 'loading', text: 'Example Font · Loading font…' })
  finishLoading()
  await expect(request).resolves.toBe(true)
  expect(notify).toHaveBeenLastCalledWith({
    kind: 'success',
    text: 'Example Font · Font is ready to use.',
  })
})

it('reports a failed load and lets a subsequent attempt succeed', async () => {
  vi.mocked(syncPrivateFonts).mockRejectedValueOnce(new Error('Invalid font'))
  await expect(downloadCatalogFont('Example Font')).resolves.toBe(false)
  expect(notify).toHaveBeenLastCalledWith({
    kind: 'error',
    text: 'Example Font · Font loading failed. Please try again. Invalid font',
  })
  await expect(downloadCatalogFont('Example Font')).resolves.toBe(true)
})

it('keeps a loading notification visible until it is replaced by completion', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(ToastHost))
    })
    await act(async () => {
      showToast('Downloading font…', 'loading')
    })
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(container.querySelector('.app-toast.loading')?.textContent).toBe('Downloading font…')
    await act(async () => {
      showToast('Font is ready to use.')
    })
    expect(container.textContent).toBe('Font is ready to use.')
    await act(async () => {
      vi.advanceTimersByTime(2500)
    })
    expect(container.textContent).toBe('')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
