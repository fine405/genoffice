import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { CropBox, DocumentImage, FontFile, FontPickerApi, PickerImage, Region } from './types'
import { cropFromPoints, imagePoint, type Point } from './crop'
import { fontPickerStrings } from './strings'
import { cssFontStyle } from './font-style'

interface Props {
  api: FontPickerApi
  lang: string
  images: DocumentImage[]
  initialImage?: DocumentImage
  target?: { label: string; text: string }
  onApply?: (family: string) => Promise<void>
  onClose: () => void
}

export function FontPicker({ api, lang, images, initialImage, target, onApply, onClose }: Props) {
  const t = fontPickerStrings(lang)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  const active = useRef(true)
  const operation = useRef(false)
  const [image, setImage] = useState<PickerImage | null>(null)
  const [crop, setCrop] = useState<CropBox | null>(null)
  const [regions, setRegions] = useState<Region[]>([])
  const [regionId, setRegionId] = useState('')
  const [fontId, setFontId] = useState('')
  const [fontFile, setFontFile] = useState<FontFile | null>(null)
  const [previewFamily, setPreviewFamily] = useState('')
  const [previewText, setPreviewText] = useState(target?.text || 'The quick brown fox')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [scanned, setScanned] = useState(false)
  const [gallery, setGallery] = useState(false)
  const [zoom, setZoom] = useState(100)
  const drag = useRef<Point | null>(null)
  const region = regions.find((r) => r.id === regionId)
  const matches = region?.font_matches ?? []
  const match = matches.find((m) => m.fonts.some((f) => f.font_id === fontId))
  const variant = match?.fonts.find((f) => f.font_id === fontId)
  const canInstall =
    fontFile &&
    ['ttf', 'otf'].includes(fontFile.font.format) &&
    !/variable/i.test(fontFile.font.style)

  useEffect(() => {
    active.current = true
    dialog.current?.showModal()
    return () => {
      active.current = false
      // Invalidate pending work using the current counter, not a captured value.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
      queueMicrotask(() => {
        if (!active.current) void api.dispose().catch(() => {})
      })
    }
  }, [api])

  async function run(label: string, work: () => Promise<void>) {
    if (operation.current) return
    operation.current = true
    setBusy(label)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      operation.current = false
      if (active.current) setBusy('')
    }
  }
  async function load(blob: Blob) {
    if (blob.size > 10 * 1024 * 1024 || !/^image\/(png|jpeg|webp)$/.test(blob.type)) {
      setError(t.unsupported)
      return
    }
    await run(t.loading, async () => {
      generation.current++
      setFontId('')
      setRegions([])
      setScanned(false)
      setImage(null)
      setCrop(null)
      const next = await api.upload(new Uint8Array(await blob.arrayBuffer()))
      if (!active.current) return
      setImage(next)
      setZoom(100)
      setGallery(false)
    })
  }
  async function loadDocumentImage(source: DocumentImage) {
    try {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i.exec(source.dataUrl)
      if (!match) throw new Error(t.unsupported)
      const bytes = Uint8Array.from(atob(match[2]!), (char) => char.charCodeAt(0))
      await load(new Blob([bytes], { type: match[1]!.toLowerCase() }))
    } catch (e) {
      setError(e instanceof Error ? e.message : t.unsupported)
    }
  }
  useEffect(() => {
    let canceled = false
    queueMicrotask(() => {
      if (initialImage && !canceled) void loadDocumentImage(initialImage)
    })
    return () => {
      canceled = true
    }
    // A new dialog owns a single initial source; subsequent changes are explicit actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const ticket = ++generation.current
    let face: FontFace | undefined
    setFontFile(null)
    setPreviewFamily('')
    setError('')
    if (!fontId) return
    void api
      .font(fontId)
      .then(async (file) => {
        if (!active.current || generation.current !== ticket) return
        const family = `font-picker-${crypto.randomUUID()}`
        face = new FontFace(family, new Uint8Array(file.bytes).buffer, {
          weight: String(file.font.weight),
          style: cssFontStyle(file.font.style),
        })
        await face.load()
        if (!active.current || generation.current !== ticket) return
        document.fonts.add(face)
        setFontFile(file)
        setPreviewFamily(family)
      })
      .catch((e) => {
        if (active.current && generation.current === ticket)
          setError(e instanceof Error ? e.message : t.previewError)
      })
    return () => {
      // Invalidate pending work using the current counter, not a captured value.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
      if (face) document.fonts.delete(face)
    }
    // Locale changes must not restart a font download.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, fontId])

  function chooseRegion(value: Region) {
    setRegionId(value.id)
    setFontId(value.font_matches[0]?.fonts[0]?.font_id || '')
    if (!target?.text) setPreviewText(value.text || 'The quick brown fox')
  }
  async function scan() {
    if (!image) return
    await run(t.scanning, async () => {
      setFontId('')
      setRegions([])
      setScanned(false)
      const result = await api.scan(image.id, crop)
      if (!active.current) return
      setRegions(result.regions)
      setScanned(true)
      const first =
        result.regions.find((r) => r.font_matches.some((m) => m.fonts.length)) ?? result.regions[0]
      if (first) chooseRegion(first)
    })
  }
  async function paste() {
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const type = item.types.find((type) => /^image\/(png|jpeg|webp)$/.test(type))
        if (type) {
          await load(await item.getType(type))
          return
        }
      }
      setError(t.noClipboard)
    } catch {
      setError(t.noClipboard)
    }
  }
  function close() {
    dialog.current?.close()
    onClose()
  }
  const previewStyle: CSSProperties = {
    fontFamily: previewFamily ? `"${previewFamily}"` : undefined,
    fontWeight: variant?.weight,
    fontStyle: cssFontStyle(variant?.style),
  }
  return (
    <dialog
      ref={dialog}
      className="font-picker"
      data-keep-edit=""
      aria-labelledby="font-picker-title"
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onPaste={(e) => {
        const file = [...e.clipboardData.items]
          .find((item) => item.type.startsWith('image/'))
          ?.getAsFile()
        if (file) {
          e.preventDefault()
          void load(file)
        }
      }}
    >
      <header className="font-picker-header">
        <div>
          <h2 id="font-picker-title">{t.title}</h2>
          <p>{t.subtitle}</p>
        </div>
        <button type="button" className="font-picker-close" aria-label={t.close} onClick={close}>
          ×
        </button>
      </header>
      <div className="font-picker-body">
        <section className="font-picker-source">
          <h3>{t.reference}</h3>
          <div className="font-picker-tools">
            <button disabled={!!busy} onClick={() => input.current?.click()}>
              {t.upload}
            </button>
            <button disabled={!!busy} onClick={() => void paste()}>
              {t.paste}
            </button>
            <button disabled={!!busy} onClick={() => setGallery(!gallery)}>
              {gallery ? t.back : t.document}
            </button>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void load(file)
              }}
            />
          </div>
          {gallery ? (
            <div className="font-picker-gallery">
              {!images.length && <p>{t.noImages}</p>}
              {images.map((source) => (
                <button key={source.id} onClick={() => void loadDocumentImage(source)}>
                  <img src={source.dataUrl} alt={source.label} />
                  <span>{source.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="font-picker-image-scroll">
              {image ? (
                <div
                  className="font-picker-image"
                  style={{
                    width: `${zoom}%`,
                    maxWidth: `${(((320 * image.width) / image.height) * zoom) / 100}px`,
                    marginInline: 'auto',
                  }}
                  onPointerDown={(e) => {
                    if (busy || e.button !== 0) return
                    e.preventDefault()
                    e.currentTarget.setPointerCapture(e.pointerId)
                    drag.current = imagePoint(
                      e.clientX,
                      e.clientY,
                      e.currentTarget.getBoundingClientRect(),
                    )
                    setCrop(null)
                    setFontId('')
                    setRegions([])
                    setScanned(false)
                    setError('')
                  }}
                  onPointerMove={(e) => {
                    if (!drag.current) return
                    setCrop(
                      cropFromPoints(
                        drag.current,
                        imagePoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect()),
                        image.width,
                        image.height,
                      ),
                    )
                  }}
                  onPointerUp={(e) => {
                    if (!drag.current) return
                    const next = cropFromPoints(
                      drag.current,
                      imagePoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect()),
                      image.width,
                      image.height,
                    )
                    drag.current = null
                    setCrop(next)
                    if (!next) setError(t.smallCrop)
                  }}
                  onPointerCancel={() => {
                    drag.current = null
                    setCrop(null)
                  }}
                >
                  <img src={image.dataUrl} alt={t.reference} draggable={false} />
                  {!crop &&
                    regions.map((r) => (
                      <button
                        key={r.id}
                        className={`font-picker-region${regionId === r.id ? ' selected' : ''}`}
                        aria-label={`${r.number}. ${r.text}`}
                        title={r.text}
                        style={{
                          left: `${(r.box.left / image.width) * 100}%`,
                          top: `${(r.box.top / image.height) * 100}%`,
                          width: `${(r.box.width / image.width) * 100}%`,
                          height: `${(r.box.height / image.height) * 100}%`,
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => chooseRegion(r)}
                      >
                        <span>{r.number}</span>
                      </button>
                    ))}
                  {crop && (
                    <div
                      className="font-picker-crop"
                      style={{
                        left: `${(crop.left / image.width) * 100}%`,
                        top: `${(crop.top / image.height) * 100}%`,
                        width: `${(crop.width / image.width) * 100}%`,
                        height: `${(crop.height / image.height) * 100}%`,
                      }}
                    >
                      <span>1</span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="font-picker-empty">{busy || t.empty}</p>
              )}
            </div>
          )}
          <p className="font-picker-hint">{t.crop}</p>
          <div className="font-picker-tools">
            <button
              disabled={!image || !!busy}
              onClick={() => {
                setCrop(null)
                setFontId('')
                setRegions([])
                setScanned(false)
              }}
            >
              {t.reset}
            </button>
            <label className="font-picker-zoom">
              <input
                type="range"
                min="100"
                max="250"
                step="25"
                value={zoom}
                aria-label="Zoom"
                onChange={(e) => setZoom(Number(e.target.value))}
              />
              {zoom}%
            </label>
            <button
              className="font-picker-primary"
              disabled={!image || !!busy}
              onClick={() => void scan()}
            >
              {busy === t.scanning ? t.scanning : t.scan}
            </button>
          </div>
        </section>
        <section className="font-picker-results">
          <h3>{t.candidates}</h3>
          {regions.length > 1 && (
            <label>
              {t.regions}
              <select
                value={regionId}
                disabled={!!busy}
                onChange={(e) => {
                  const next = regions.find((r) => r.id === e.target.value)
                  if (next) chooseRegion(next)
                }}
              >
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.number}. {r.text.slice(0, 60)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="font-picker-matches">
            {!matches.length && (
              <p className="font-picker-empty">{busy || (scanned ? t.noResults : t.beforeScan)}</p>
            )}
            {matches.map((candidate, index) => {
              const selected = candidate === match
              return (
                <button
                  key={candidate.family_id}
                  className={`font-picker-match${selected ? ' selected' : ''}`}
                  disabled={!!busy || !candidate.fonts.length}
                  aria-pressed={selected}
                  onClick={() => setFontId(candidate.fonts[0]!.font_id)}
                >
                  <span className="font-picker-match-heading">
                    <strong>{candidate.name}</strong>
                    {index === 0 && <small>{t.similar}</small>}
                  </span>
                  <FontSample
                    api={api}
                    fontId={selected ? fontId : candidate.fonts[0]?.font_id || ''}
                    text={previewText || candidate.name}
                  />
                  <small>{selected ? variant?.full_name : candidate.fonts[0]?.full_name}</small>
                </button>
              )
            })}
          </div>
          {match && (
            <label>
              {t.variant}
              <select disabled={!!busy} value={fontId} onChange={(e) => setFontId(e.target.value)}>
                {match.fonts.map((font) => (
                  <option key={font.font_id} value={font.font_id}>
                    {font.full_name} · {font.weight}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {t.preview}
            <input value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
          </label>
          <div className="font-picker-preview" style={previewStyle}>
            {previewText}
          </div>
          <p className="font-picker-hint">{t.suggestion}</p>
          {fontFile && !canInstall && <p className="font-picker-hint">{t.downloadOnly}</p>}
        </section>
      </div>
      {(error || notice || busy) && (
        <p
          role={error ? 'alert' : 'status'}
          className={`font-picker-message${error ? ' error' : ''}`}
        >
          {error || busy || notice}
        </p>
      )}
      <footer className="font-picker-footer">
        <p>{target ? `${t.target}：${target.label}` : t.sourceOnly}</p>
        <div className="font-picker-tools">
          <button
            disabled={!fontId || !!busy}
            onClick={() =>
              void run(t.loading, async () => {
                if (await api.download(fontId)) setNotice(t.downloaded)
              })
            }
          >
            {t.download}
          </button>
          <button
            disabled={!canInstall || !!busy}
            onClick={() =>
              void run(t.loading, async () => {
                await api.install(fontId)
                setNotice(t.added)
              })
            }
          >
            {t.add}
          </button>
          {target && onApply && (
            <button
              className="font-picker-primary"
              disabled={!canInstall || !!busy}
              onClick={() =>
                void run(t.loading, async () => {
                  const family = await api.install(fontId)
                  if (!active.current) return
                  // A modal makes the editing surface inert; release it before restoring the selection.
                  dialog.current?.close()
                  try {
                    await onApply(family)
                    onClose()
                  } catch (e) {
                    dialog.current?.showModal()
                    throw e
                  }
                })
              }
            >
              {t.apply}
            </button>
          )}
        </div>
      </footer>
    </dialog>
  )
}

/** Every candidate uses its actual bytes, never a system fallback presented as a match. */
function FontSample({ api, fontId, text }: { api: FontPickerApi; fontId: string; text: string }) {
  const [style, setStyle] = useState<CSSProperties | null>(null)
  useEffect(() => {
    let canceled = false
    let face: FontFace | undefined
    setStyle(null)
    if (!fontId) return
    void api
      .font(fontId)
      .then(async ({ font, bytes }) => {
        if (canceled) return
        const family = `font-sample-${crypto.randomUUID()}`
        face = new FontFace(family, new Uint8Array(bytes).buffer, {
          weight: String(font.weight),
          style: cssFontStyle(font.style),
        })
        await face.load()
        if (canceled) return
        document.fonts.add(face)
        setStyle({
          fontFamily: `"${family}"`,
          fontWeight: font.weight,
          fontStyle: cssFontStyle(font.style),
        })
      })
      .catch(() => {})
    return () => {
      canceled = true
      if (face) document.fonts.delete(face)
    }
  }, [api, fontId])
  return (
    <span className="font-picker-sample" style={style ?? undefined}>
      {style ? text : '…'}
    </span>
  )
}
