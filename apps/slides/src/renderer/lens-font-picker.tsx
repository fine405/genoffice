import { useCallback, useState, type RefObject } from 'react'
import type { RenderNode } from '@genoffice/pptx-render'
import { FontPicker } from '@genoffice/font-picker'
import type { DocumentImage, FontPickerApi, PickerRequest } from '@genoffice/font-picker/types'
import '@genoffice/font-picker/style.css'
import type { ActionCtx } from './action-context'
import { applySelectionFontFace, restoreEditSelection, saveEditSelection } from './TextEditOverlay'

async function invoke<T>(request: PickerRequest): Promise<T> {
  const result = await window.slidesApi.fontPicker(request)
  if (!result.ok) throw new Error(result.error)
  return result.value as T
}
const api: FontPickerApi = {
  upload: (bytes) => invoke({ action: 'upload', bytes }),
  scan: (imageId, crop) => invoke({ action: 'scan', imageId, crop }),
  font: (fontId) => invoke({ action: 'font', fontId }),
  install: (fontId) => invoke({ action: 'install', fontId }),
  download: (fontId) => invoke({ action: 'download', fontId }),
  dispose: () => invoke({ action: 'dispose' }),
}

export function documentPictures(ctx: Pick<ActionCtx, 'slides'>): DocumentImage[] {
  const images: DocumentImage[] = []
  ctx.slides.forEach((slide, index) => {
    function visit(nodes: RenderNode[]) {
      for (const node of nodes) {
        if (node.type === 'group') visit(node.children)
        if (
          node.type === 'picture' &&
          !node.media &&
          /^data:image\/(png|jpeg|webp);/i.test(node.dataUrl || '')
        ) {
          images.push({
            id: `${index}:${node.sourceId}`,
            label: `${index + 1} · ${node.sourceId}`,
            dataUrl: node.dataUrl!,
          })
        }
      }
    }
    visit(slide.nodes)
  })
  return images
}
function nodeText(node: RenderNode): string {
  if (node.type === 'group') return node.children.map(nodeText).join(' ')
  if (node.type === 'table')
    return node.cells
      .map((cell) =>
        cell.text?.lines
          .map((line) =>
            line.runs
              .filter((r) => !r.isBullet)
              .map((r) => r.text)
              .join(''),
          )
          .join(' '),
      )
      .join(' ')
  if (node.type === 'text' || node.type === 'shape')
    return (
      node.text?.lines
        .map((line) =>
          line.runs
            .filter((r) => !r.isBullet)
            .map((r) => r.text)
            .join(''),
        )
        .join(' ') || ''
    )
  return ''
}

export function useLensFontPicker(ctxRef: RefObject<ActionCtx>, lang: string) {
  const [state, setState] = useState<{
    images: DocumentImage[]
    initialImage?: DocumentImage
    target?: { label: string; text: string }
    apply?: (family: string) => Promise<void>
  } | null>(null)
  const open = useCallback(
    (pictureId?: string) => {
      const ctx = ctxRef.current
      saveEditSelection()
      const images = documentPictures(ctx)
      const ids = [...ctx.selectedIds]
      const current = ctx.current
      const slide = ctx.slide
      const path = ctx.path
      const editing = ctx.editing
      const editingCell = ctx.editingCell
      const text = pictureId
        ? ''
        : editing || editingCell
          ? window.getSelection()?.toString() ||
            ids
              .map((id) => ctx.findNodeCtx(id)?.node)
              .filter((n): n is RenderNode => !!n)
              .map(nodeText)
              .join(' ')
          : ids
              .map((id) => ctx.findNodeCtx(id)?.node)
              .filter((n): n is RenderNode => !!n)
              .map(nodeText)
              .join(' ')
      const target =
        !pictureId && text.trim()
          ? {
              label: lang.startsWith('zh')
                ? `第 ${current + 1} 页 · 已选文字`
                : `Slide ${current + 1} · selected text`,
              text: text.trim().slice(0, 120),
            }
          : undefined
      setState({
        images,
        initialImage: pictureId
          ? images.find((i) => i.id === `${current}:${pictureId}`)
          : undefined,
        target,
        apply: target
          ? async (family) => {
              const live = ctxRef.current
              if (live.current !== current || live.path !== path || live.slide !== slide) {
                throw new Error(
                  lang.startsWith('zh')
                    ? '文档已发生变化，请关闭弹窗后重新选择文字。'
                    : 'The document changed. Close this dialog and select the text again.',
                )
              }
              if (editing || editingCell) {
                if (
                  live.editing !== editing ||
                  live.editingCell !== editingCell ||
                  !restoreEditSelection()
                )
                  throw new Error('The text selection is no longer available.')
                if (!applySelectionFontFace(family))
                  throw new Error('The text selection is no longer available.')
                const root = document.activeElement
                if (root instanceof HTMLElement) root.blur()
                return
              }
              const groupId = ctx.groupIdOf(ids[0]!)
              const updated = await window.slidesApi.setElementFont({
                slideIndex: current,
                sourceIds: ids,
                fontFamily: family,
                bold: false,
                italic: false,
                ...(groupId ? { groupId } : {}),
              })
              if (!updated) throw new Error('The text selection is no longer available.')
              live.applySlide(current, updated)
            }
          : undefined,
      })
    },
    [ctxRef, lang],
  )
  const close = useCallback(() => {
    setState(null)
    restoreEditSelection()
  }, [])
  return {
    open,
    dialog: state ? (
      <FontPicker api={api} lang={lang} {...state} onApply={state.apply} onClose={close} />
    ) : null,
  }
}
