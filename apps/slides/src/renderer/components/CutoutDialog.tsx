import React, { useEffect, useRef, useState } from 'react'
import type { CutoutTargetState } from '../action-context'
import type { ImageLabResult } from '../../shared/image-lab'
import { useI18n } from '../i18n/locale'
import { imageLabStrings } from '../image-lab-strings'
import './cutout-dialog.css'

interface Props {
  target: CutoutTargetState
  onApply: (result: Extract<ImageLabResult, { ok: true }>) => void
  onCancel: () => void
}

export function CutoutDialog({ target, onApply, onCancel }: Props) {
  const { t, lang } = useI18n()
  const s = imageLabStrings(lang)
  const [attempt, setAttempt] = useState(0)
  const [stage, setStage] = useState('connecting')
  const [preview, setPreview] = useState<string>()
  const [error, setError] = useState<string>()
  const [original, setOriginal] = useState(false)
  const [applying, setApplying] = useState(false)
  const requestRef = useRef<string | null>(null)
  const cancelRef = useRef(onCancel)
  cancelRef.current = () => {
    if (!applying) onCancel()
  }

  useEffect(() => {
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    setPreview(undefined)
    setError(undefined)
    setStage('connecting')
    setOriginal(false)
    const unsubscribe = window.slidesApi.onImageLabProgress((progress) => {
      if (progress.requestId === requestId) setStage(progress.stage)
    })
    void window.slidesApi
      .imageLab({
        action: 'prepare',
        requestId,
        slideIndex: target.slideIndex,
        sourceId: target.sourceId,
      })
      .then((result) => {
        if (requestRef.current !== requestId) return
        if (result.ok) setPreview(result.preview)
        else setError(result.error)
      })
      .catch(() => {
        if (requestRef.current === requestId) setError('Image Lab connection failed.')
      })
    return () => {
      requestRef.current = null
      unsubscribe()
      void window.slidesApi.imageLab({ action: 'cancel', requestId })
    }
  }, [target, attempt])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const apply = async () => {
    const requestId = requestRef.current
    if (!requestId || !preview || applying) return
    setApplying(true)
    try {
      const result = await window.slidesApi.imageLab({ action: 'apply', requestId })
      if (requestRef.current !== requestId) return
      if (result.ok) onApply(result)
      else {
        setError(result.error)
        setPreview(undefined)
      }
    } catch {
      setError(s.failed)
      setPreview(undefined)
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !applying && onCancel()}>
      <div
        className="modal image-lab-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-lab-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="image-lab-title">{s.title}</h2>
        <p className="image-lab-hint">{s.hint}</p>
        <div className="image-lab-tabs" role="group" aria-label={s.result}>
          <button aria-pressed={original} disabled={!preview} onClick={() => setOriginal(true)}>
            {s.original}
          </button>
          <button aria-pressed={!original} disabled={!preview} onClick={() => setOriginal(false)}>
            {s.result}
          </button>
        </div>
        <div className="image-lab-stage" aria-busy={!preview && !error}>
          <img
            src={original || !preview ? target.dataUrl : preview}
            alt={original || !preview ? s.original : s.result}
          />
        </div>
        <div className="image-lab-status" role={error ? 'alert' : 'status'} aria-live="polite">
          {!preview && !error && <span className="image-lab-spinner" aria-hidden="true" />}
          {error ||
            (applying ? s.applying : preview ? s.ready : s.stages[stage] || s.stages.running)}
        </div>
        <div className="modal-actions">
          <button onClick={onCancel} disabled={applying} autoFocus>
            {t('paneCancel')}
          </button>
          {error && <button onClick={() => setAttempt((value) => value + 1)}>{s.retry}</button>}
          <button
            className="primary"
            onClick={() => void apply()}
            disabled={!preview || applying || !!error}
          >
            {applying ? s.applying : t('paneCutoutApply')}
          </button>
        </div>
      </div>
    </div>
  )
}
