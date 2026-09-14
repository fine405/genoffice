import { afterEach, describe, expect, it } from 'vitest'
import { applySelectionFontFace, extractParagraphs } from '../src/renderer/TextEditOverlay'

afterEach(() => {
  document.body.innerHTML = ''
})

function editor() {
  const root = document.createElement('div')
  root.tabIndex = 0
  Object.defineProperty(root, 'isContentEditable', { value: true })
  root.innerHTML =
    '<div><span data-font="Original Font" data-display-font="Calibri" style="font-family: Calibri; font-weight: bold; font-style: italic">Before selected after</span></div><div><span style="font-family: Other">Second line</span></div>'
  document.body.append(root)
  root.focus()
  return root
}

describe('downloaded static face application', () => {
  it('changes only selected characters and retains original fonts and styles around them', () => {
    const root = editor()
    const text = root.querySelector('span')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 7)
    range.setEnd(text, 15)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    expect(applySelectionFontFace('Chosen SemiBold')).toBe(true)
    const runs = extractParagraphs(root, 1)[0]!.runs
    expect(
      runs.map(({ text, fontFamily, bold, italic }) => ({ text, fontFamily, bold, italic })),
    ).toEqual([
      { text: 'Before ', fontFamily: 'Original Font', bold: true, italic: true },
      { text: 'selected', fontFamily: 'Chosen SemiBold', bold: false, italic: false },
      { text: ' after', fontFamily: 'Original Font', bold: true, italic: true },
    ])
    expect(extractParagraphs(root, 1)[1]!.runs[0]!.fontFamily).toBe('Other')
  })

  it('handles a range spanning paragraphs without combining their text', () => {
    const root = editor()
    const range = document.createRange()
    range.setStart(root.querySelector('span')!.firstChild!, 7)
    range.setEnd(root.querySelectorAll('span')[1]!.firstChild!, 6)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    expect(applySelectionFontFace('Chosen Regular')).toBe(true)
    const paragraphs = extractParagraphs(root, 1)
    expect(paragraphs.map((p) => p.runs.map((r) => r.text).join(''))).toEqual([
      'Before selected after',
      'Second line',
    ])
    expect(paragraphs[0]!.runs[0]!.fontFamily).toBe('Original Font')
    expect(paragraphs[1]!.runs[0]!.fontFamily).toBe('Chosen Regular')
    expect(paragraphs[1]!.runs[1]!.fontFamily).toBe('Other')
  })
})
