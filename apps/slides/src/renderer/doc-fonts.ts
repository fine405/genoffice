/**
 * Office-private font registration. Layout (main process) may resolve run fonts to files
 * Chromium cannot see (PowerPoint's bundled DFonts, Office cloud fonts); glyph positions are
 * baked with those metrics, so the canvas must draw with the same faces. Main exposes the
 * referenced faces + extracted sfnt bytes; here they become document FontFaces. Canvas layers
 * redraw via the FontFaceSet 'loadingdone' listener in SlideCanvas.
 */

const requested = new Set<string>()
const loading = new Map<string, Promise<boolean>>()

declare global {
  interface Window {
    /** Set after each private-font sync completes; the fidelity harness waits on it before screenshots. */
    __genofficeDocFontsSynced?: boolean
  }
}

/** Fetch and register any private faces not yet requested. Safe to call often (idempotent). */
export async function syncPrivateFonts(requiredFamily?: string): Promise<void> {
  window.__genofficeDocFontsSynced = false
  let faces: Array<{ id: string; family: string; bold: boolean; italic: boolean }>
  try {
    faces = await window.slidesApi.privateFontFaces()
  } catch (error) {
    window.__genofficeDocFontsSynced = true
    if (requiredFamily) throw error
    return
  }
  // Test harnesses stub the bridge with null results
  if (!Array.isArray(faces)) {
    window.__genofficeDocFontsSynced = true
    if (requiredFamily) throw new Error('The installed font could not be loaded. Please try again.')
    return
  }
  const added = await Promise.all(
    faces
      .filter((f) => !requested.has(f.id))
      .map((f) => {
        const pending = loading.get(f.id)
        if (pending) return pending
        const request = (async () => {
          let face: FontFace | undefined
          try {
            const data = await window.slidesApi.privateFontData(f.id)
            if (!data) return false
            face = new FontFace(f.family, data, {
              weight: f.bold ? '700' : '400',
              style: f.italic ? 'italic' : 'normal',
            })
            await face.load()
            document.fonts.add(face)
            requested.add(f.id)
            return true
          } catch {
            if (face) document.fonts.delete(face)
            return false
          } finally {
            loading.delete(f.id)
          }
        })()
        loading.set(f.id, request)
        return request
      }),
  )
  // ArrayBuffer-backed FontFaces parse synchronously in the constructor, so the set never
  // enters the loading state and never emits a real 'loadingdone' — canvases already
  // rastered with a fallback face would keep the stale pixels. Fire it by hand.
  if (added.some(Boolean)) {
    document.fonts.dispatchEvent(new Event('loadingdone'))
    // The listeners redraw Konva layers on the next animation frame; the fidelity
    // harness screenshots as soon as the synced flag flips, so hold it until the
    // redraw has actually presented (two rAFs = schedule + commit).
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  }
  window.__genofficeDocFontsSynced = true
  if (requiredFamily && !faces.some((f) => f.family === requiredFamily && requested.has(f.id))) {
    throw new Error('The font was saved but could not be loaded. Please try adding it again.')
  }
}
