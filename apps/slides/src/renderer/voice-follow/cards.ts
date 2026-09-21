import type { RenderNode, RenderSlide, RenderTextLayout } from '@genoffice/pptx-render'
import type { FollowCard } from '../../shared/voice-follow'

function textOf(text?: RenderTextLayout): string {
  return (text?.lines ?? [])
    .map((l) =>
      [...l.runs]
        .sort((a, b) => (a.logicalOrder ?? 0) - (b.logicalOrder ?? 0))
        .filter((r) => !r.isBullet)
        .map((r) => r.text)
        .join(''),
    )
    .join('\n')
}
function nodeText(nodes: RenderNode[]): { title: string; chunks: string[] } {
  let title = ''
  const chunks: string[] = []
  for (const n of nodes) {
    if (n.decoration) continue
    if (n.type === 'group') {
      const child = nodeText(n.children)
      title ||= child.title
      chunks.push(...child.chunks)
    } else if (n.type === 'text' || n.type === 'shape') {
      const value = textOf(n.text).trim()
      if (value) chunks.push(value)
      if (n.placeholder === 'title' || n.placeholder === 'ctrTitle') title ||= value
    } else if (n.type === 'table') {
      chunks.push(
        [...n.cells]
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((c) => textOf(c.text))
          .join('\n'),
      )
    } else if (n.type === 'chart') {
      chunks.push(n.labels.map((l) => l.text).join('\n'))
    }
  }
  return { title, chunks }
}
export function buildFollowCards(
  slides: RenderSlide[],
  notes: string[],
  order: number[],
): FollowCard[] {
  return order.map((index) => {
    const { title, chunks } = nodeText(slides[index]!.nodes)
    const text = [...new Set(chunks)].join('\n')
    const note = notes[index] ?? ''
    return {
      id: `page_${index + 1}`,
      index,
      title: (title || chunks[0] || `第 ${index + 1} 页`).slice(0, 100),
      text: text.slice(0, 1200),
      notes: note.slice(0, 600),
      hint: '',
      truncated: text.length > 1200 || note.length > 600,
    }
  })
}
