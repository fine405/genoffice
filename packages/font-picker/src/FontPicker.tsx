import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  CropBox,
  DocumentImage,
  FontFile,
  FontPickerApi,
  FontProgress,
  PickerImage,
  Region,
} from './types'
import { ImageStage, regionStyle } from './ImageStage'
import { fontPickerStrings } from './strings'
import { loadFontPreview } from '@font-lab/sdk/browser'

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
  const [fontProgress, setFontProgress] = useState<FontProgress | null>(null)
  const [fontLoading, setFontLoading] = useState(false)
  const [fontAttempt, setFontAttempt] = useState(0)
  const [previewFamily, setPreviewFamily] = useState('')
  const [previewText, setPreviewText] = useState(target?.text || 'The quick brown fox')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [scanned, setScanned] = useState(false)
  const [gallery, setGallery] = useState(false)
  const [editing, setEditing] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const region = regions.find((r) => r.id === regionId)
  const matches = region?.font_matches ?? []
  const match = matches.find((m) => m.fonts.some((f) => f.font_id === fontId))
  const variant = match?.fonts.find((f) => f.font_id === fontId)
  const canInstall = fontFile && ['ttf', 'otf'].includes(fontFile.font.format)

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
      setEditing(true)
      setEditingId(null)
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
    const abort = new AbortController()
    let preview: Awaited<ReturnType<typeof loadFontPreview>> | undefined
    let receivingFont = true
    const unsubscribe = api.onFontProgress?.((progress) => {
      if (
        receivingFont &&
        active.current &&
        generation.current === ticket &&
        progress.fontId === fontId
      )
        setFontProgress(progress)
    })
    setFontFile(null)
    setPreviewFamily('')
    setError('')
    setFontLoading(false)
    setFontProgress(fontId ? { fontId, phase: 'preparing', received: 0 } : null)
    if (!fontId) return unsubscribe
    void api
      .font(fontId)
      .then(async (file) => {
        receivingFont = false
        if (!active.current || generation.current !== ticket) return
        setFontProgress(null)
        setFontLoading(true)
        preview = await loadFontPreview(new Response(new Uint8Array(file.bytes)), file.font, {
          signal: abort.signal,
        })
        if (!active.current || generation.current !== ticket) {
          preview.dispose()
          return
        }
        setFontFile(file)
        setPreviewFamily(preview.family)
        setFontLoading(false)
      })
      .catch((e) => {
        receivingFont = false
        if (active.current && generation.current === ticket) {
          setFontProgress(null)
          setFontLoading(false)
          setError(e instanceof Error ? e.message : t.previewError)
        }
      })
    return () => {
      // Invalidate pending work using the current counter, not a captured value.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
      unsubscribe?.()
      abort.abort()
      preview?.dispose()
    }
    // Locale changes must not restart a font download.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, fontId, fontAttempt])

  function chooseRegion(value: Region) {
    setRegionId(value.id)
    setFontId(value.font_matches[0]?.fonts[0]?.font_id || '')
    if (!target?.text) setPreviewText(value.text || 'The quick brown fox')
  }
  async function scan() {
    if (!image) return
    if (editing && crop && (crop.width < 8 || crop.height < 8)) {
      setError(t.smallCrop)
      return
    }
    await run(t.scanning, async () => {
      const result = await api.scan(image.image_id, editing ? crop : null)
      if (!active.current) return
      const previous = regions.find((region) => region.id === editingId)
      const nextNumber = Math.max(0, ...regions.map((region) => region.number)) + 1
      const incoming =
        editing && crop
          ? result.regions.map((region, index) => ({
              ...region,
              id: index === 0 && previous ? previous.id : crypto.randomUUID(),
              number:
                index === 0 && previous ? previous.number : nextNumber + index - (previous ? 1 : 0),
            }))
          : result.regions
      if (editing && crop && !incoming.length) {
        setError(t.noResults)
        return
      }
      setRegions(
        editing && crop
          ? [...regions.filter((region) => region.id !== editingId), ...incoming].sort(
              (a, b) => a.number - b.number,
            )
          : incoming,
      )
      setScanned(true)
      setEditing(false)
      setEditingId(null)
      setCrop(null)
      setFontId('')
      const first =
        incoming.find((region) => region.font_matches.some((match) => match.fonts.length)) ??
        incoming[0]
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
    fontStyle: variant?.style,
  }
  const progressText = fontLoading
    ? t.loadingFont
    : fontProgress?.phase === 'preparing'
      ? t.preparingFont
      : fontProgress?.phase === 'verifying'
        ? t.verifyingFont
        : t.downloadingFont
  const percent =
    fontProgress?.phase === 'downloading' && fontProgress.total
      ? Math.floor((fontProgress.received / fontProgress.total) * 100)
      : undefined
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
          ) : !image ? (
            <p className="font-picker-empty">{t.empty}</p>
          ) : null}
          {image && !gallery && (
            <ImageStage
              key={image.image_id}
              image={image}
              regions={regions}
              selectedId={regionId}
              busy={!!busy}
              crop={crop}
              editing={editing}
              lang={lang}
              onCrop={setCrop}
              onSelect={chooseRegion}
              onEdit={(region) => {
                setEditing(true)
                setEditingId(region?.id ?? null)
                setCrop(region?.box ?? null)
                setError('')
              }}
              onCancel={() => {
                setEditing(false)
                setEditingId(null)
                setCrop(null)
              }}
            />
          )}
          <button
            className="font-picker-primary font-picker-scan"
            disabled={
              !image || !!busy || (editing && !!crop && (crop.width < 8 || crop.height < 8))
            }
            onClick={() => void scan()}
          >
            {busy === t.scanning ? t.scanning : t.scan}
          </button>
        </section>
        <section className="font-picker-results">
          <h3>{t.candidates}</h3>
          {regions.length > 0 && (
            <div className="font-picker-region-list" role="group" aria-label={t.regions}>
              {regions.map((item) => (
                <button
                  key={item.id}
                  className={`font-picker-region-row${regionId === item.id ? ' selected' : ''}`}
                  style={regionStyle(item.number)}
                  disabled={!!busy}
                  aria-pressed={regionId === item.id}
                  onClick={() => chooseRegion(item)}
                >
                  <span>{String(item.number).padStart(2, '0')}</span>
                  <strong>{item.text || t.manualRegion}</strong>
                  <small>
                    {item.status === 'review'
                      ? t.reviewRegion
                      : item.status === 'error'
                        ? t.failedRegion
                        : item.font_matches[0]?.name}
                  </small>
                </button>
              ))}
            </div>
          )}
          {region?.error && <p className="font-picker-hint">{region.error}</p>}
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
                    <span className="font-picker-rank">{String(index + 1).padStart(2, '0')}</span>
                    <strong>{candidate.name}</strong>
                    <span className="font-picker-score" title={t.scoreHint}>
                      {candidate.score.toFixed(3)}
                    </span>
                    {index === 0 && <small>{t.similar}</small>}
                  </span>
                  <FontSample
                    key={fontAttempt}
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
      {(error || notice || busy || fontProgress || fontLoading) && (
        <div
          role={error ? 'alert' : 'status'}
          aria-busy={!error && !!(busy || fontProgress || fontLoading)}
          className={`font-picker-message${error ? ' error' : ''}`}
        >
          <span>
            {error ||
              (fontProgress || fontLoading
                ? `${variant?.full_name || ''} · ${progressText}${percent === undefined ? '' : ` ${percent}%`}`
                : busy || notice)}
          </span>
          {!error && (busy || fontProgress || fontLoading) && (
            <progress aria-label={progressText} max={100} value={percent} />
          )}
          {error && fontId && !fontFile && (
            <button disabled={!!busy} onClick={() => setFontAttempt((attempt) => attempt + 1)}>
              {t.retry}
            </button>
          )}
        </div>
      )}
      <footer className="font-picker-footer">
        <p>{target ? `${t.target}：${target.label}` : t.sourceOnly}</p>
        <div className="font-picker-tools">
          <button
            disabled={!fontId || !!busy}
            onClick={() =>
              void run(t.savingFont, async () => {
                if (await api.download(fontId)) setNotice(t.downloaded)
              })
            }
          >
            {busy === t.savingFont ? t.savingFont : t.download}
          </button>
          <button
            disabled={!canInstall || !!busy}
            onClick={() =>
              void run(t.installingFont, async () => {
                await api.install(fontId)
                setNotice(t.added)
              })
            }
          >
            {busy === t.installingFont ? t.installingFont : t.add}
          </button>
          {target && onApply && (
            <button
              className="font-picker-primary"
              disabled={!canInstall || !!busy}
              onClick={() =>
                void run(t.applyingFont, async () => {
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
              {busy === t.applyingFont ? t.applyingFont : t.apply}
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
    const abort = new AbortController()
    let preview: Awaited<ReturnType<typeof loadFontPreview>> | undefined
    setStyle(null)
    if (!fontId) return
    void api
      .font(fontId)
      .then(async ({ font, bytes }) => {
        if (canceled) return
        preview = await loadFontPreview(new Response(new Uint8Array(bytes)), font, {
          signal: abort.signal,
        })
        if (canceled) {
          preview.dispose()
          return
        }
        setStyle({
          fontFamily: `"${preview.family}"`,
          fontWeight: font.weight,
          fontStyle: font.style,
        })
      })
      .catch(() => {})
    return () => {
      canceled = true
      abort.abort()
      preview?.dispose()
    }
  }, [api, fontId])
  return (
    <span className="font-picker-sample" style={style ?? undefined}>
      {style ? text : '…'}
    </span>
  )
}
