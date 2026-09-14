import * as opentype from 'opentype.js'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { FontFile } from '@genoffice/font-picker/types'

vi.mock('../src/main/shaped-metrics', () => ({
  initShapedMetrics: () => {},
  shapedMeasure: () => null,
  shapedFamily: () => null,
  gtMeasure: () => null,
  complexScriptOf: () => null,
}))
const temp = mkdtempSync(join(tmpdir(), 'font-lab-test-'))
vi.mock('electron', () => ({ app: { getPath: () => temp }, dialog: {}, ipcMain: {} }))
import { fontServiceUrl, installFontLabFont, installedFontLabFonts } from '../src/main/font-picker'
import {
  createSystemFontMetrics,
  setFontLabDir,
  resetFontRegistry,
  listPrivateFontFaces,
  getPrivateFontData,
} from '../src/main/fonts'

afterAll(() => {
  rmSync(temp, { recursive: true, force: true })
  resetFontRegistry()
})
function fixture(): FontFile {
  const bytes = new Uint8Array(
    readFileSync(resolve('..', '..', 'packages/ui/src/fonts/Carlito-Regular.ttf')),
  )
  return {
    bytes,
    font: {
      font_id: 'test-carlito',
      family_id: 'carlito',
      family: 'Carlito',
      full_name: 'Font Lab Test Regular',
      style: 'normal',
      weight: 400,
      file_url: '/font',
      source_url: 'https://example.test/font',
      license_status: 'unknown',
      license_url: null,
      format: 'ttf',
      media_type: 'font/ttf',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size_bytes: bytes.length,
      internal_family: 'Carlito',
      postscript_name: 'Carlito',
      embedding_flags: 0,
    },
  }
}

describe('Font Lab font registration', () => {
  it('allows HTTPS and loopback endpoints only, with no URL credentials', () => {
    expect(fontServiceUrl('http://127.0.0.1:8100/api/v1/')).toBe('http://127.0.0.1:8100/api/v1')
    expect(fontServiceUrl('https://fonts.example/api/v1')).toContain('https:')
    expect(() => fontServiceUrl('http://example.test/api/v1')).toThrow()
    expect(() => fontServiceUrl('https://secret@fonts.example/api/v1')).toThrow()
  })
  it('installs a real face and resolves identical font bytes for metrics and canvas', () => {
    const file = fixture()
    expect(installFontLabFont(file)).toBe('Font Lab Test Regular')
    setFontLabDir(join(temp, 'fonts/font-lab'))
    resetFontRegistry()
    const metrics = createSystemFontMetrics()
    expect(
      metrics.measure('Font preview', {
        fontFamily: 'Font Lab Test Regular',
        fontSizePx: 32,
        bold: false,
        italic: false,
      }),
    ).toBeGreaterThan(10)
    const face = listPrivateFontFaces().find((face) => face.family === 'Font Lab Test Regular')
    expect(face).toBeDefined()
    const canvasFont = opentype.parse(getPrivateFontData(face!.id)!)
    const sourceFont = opentype.parse(new Uint8Array(file.bytes).buffer)
    expect(canvasFont.charToGlyph('F').advanceWidth).toBe(sourceFont.charToGlyph('F').advanceWidth)
    expect(readFileSync(join(temp, 'fonts/font-lab/Font Lab Test Regular.ttf'))).toEqual(
      Buffer.from(file.bytes),
    )
    expect(installedFontLabFonts()).toContain('Font Lab Test Regular')
    expect(installFontLabFont(file)).toBe('Font Lab Test Regular')
  })
  it('rejects corrupt files, unsupported formats and unsafe names', () => {
    const file = fixture()
    expect(() =>
      installFontLabFont({ ...file, font: { ...file.font, full_name: '../escape' } }),
    ).toThrow('name')
    expect(() =>
      installFontLabFont({ ...file, font: { ...file.font, sha256: '0'.repeat(64) } }),
    ).toThrow('checksum')
    expect(() => installFontLabFont({ ...file, font: { ...file.font, format: 'woff2' } })).toThrow(
      'TTF',
    )
  })
})
