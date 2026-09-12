import { useCallback, useEffect, useRef, useState } from 'react'
import { fontPickerStrings } from '@genoffice/font-picker/strings'
import { getLang } from './i18n/locale'
import { showToast } from './components/toast-bus'
import { syncPrivateFonts } from './doc-fonts'

export interface CatalogEntry {
  family: string
  script: 'latin' | 'ja' | 'ko' | 'sc' | 'tc'
  installed: boolean
  downloading: boolean
  custom?: boolean
}

let cached: CatalogEntry[] | null = null

/** Shared by the font menu and the missing-font banner; readiness includes canvas loading. */
export async function downloadCatalogFont(family: string): Promise<boolean> {
  const labels = fontPickerStrings(getLang())
  let downloaded = false
  showToast(`${family} · ${labels.downloadingFont}`, 'loading')
  try {
    const result = await window.slidesApi.fontDownload?.(family)
    if (!result?.ok) throw new Error(result?.error)
    downloaded = true
    showToast(`${family} · ${labels.loadingFont}`, 'loading')
    await syncPrivateFonts(family)
    showToast(`${family} · ${labels.fontReady}`)
    return true
  } catch (error) {
    const message = downloaded ? labels.fontLoadFailed : labels.fontDownloadFailed
    showToast(
      `${family} · ${message}${error instanceof Error && error.message ? ` ${error.message}` : ''}`,
      'error',
    )
    return false
  }
}

/**
 * Downloadable font catalog + install actions. Loaded lazily from the picker's
 * open click (same pattern as useSystemFontFamilies); download/install push new
 * layouts from main via deck-changed, so callers only refresh list state here.
 */
export function useFontCatalog(): {
  readonly catalog: CatalogEntry[]
  readonly busy: ReadonlySet<string>
  readonly failed: ReadonlySet<string>
  readonly load: () => void
  readonly download: (family: string) => Promise<boolean>
  readonly installLocal: () => Promise<string[]>
} {
  const [catalog, setCatalog] = useState<CatalogEntry[]>(cached ?? [])
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const pending = useRef(new Set<string>())

  const load = useCallback(() => {
    void window.slidesApi
      .fontCatalog?.()
      .then((c) => {
        cached = c
        setCatalog(c)
      })
      .catch(() => {})
  }, [])

  const download = useCallback(
    async (family: string): Promise<boolean> => {
      if (pending.current.has(family)) return false
      pending.current.add(family)
      setBusy((s) => new Set(s).add(family))
      setFailed((s) => {
        const n = new Set(s)
        n.delete(family)
        return n
      })
      try {
        const ok = await downloadCatalogFont(family)
        if (!ok) setFailed((s) => new Set(s).add(family))
        return ok
      } finally {
        pending.current.delete(family)
        setBusy((s) => {
          const n = new Set(s)
          n.delete(family)
          return n
        })
        load()
      }
    },
    [load],
  )

  const installLocal = useCallback(async (): Promise<string[]> => {
    try {
      const r = await window.slidesApi.fontInstallLocal?.()
      return r?.families ?? []
    } catch {
      return []
    } finally {
      load()
    }
  }, [load])

  useEffect(() => window.slidesApi.onFontsChanged?.(load), [load])

  return { catalog, busy, failed, load, download, installLocal }
}
