/** Slides adapter for the independent Lens client. Credentials never cross the preload bridge. */
import { app, dialog, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as opentype from 'opentype.js'
import { createPickerSession } from '@genoffice/font-picker/service'
import type { FontFile, PickerRequest, PickerResult } from '@genoffice/font-picker/types'
import { showSaveDialogWithMemory } from '@genoffice/electron-utils'
import { setLensFontDir } from './fonts'

export const lensFontDir = (): string => join(app.getPath('userData'), 'fonts', 'lens')
export function installedLensFonts(): string[] {
  try {
    return readdirSync(lensFontDir())
      .filter((name) => /\.(ttf|otf)$/.test(name))
      .map((name) => name.replace(/\.[^.]+$/, ''))
  } catch {
    return []
  }
}
export function fontServiceUrl(
  value = process.env.GENOFFICE_FONT_SERVICE_URL || 'http://127.0.0.1:8000/api/v1',
): string {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
  ) {
    throw new Error('Use HTTPS or a local loopback address for the font service.')
  }
  return url.href.replace(/\/+$/, '')
}

/** Full face names preserve non-binary weights without changing the Office run schema. */
export function installLensFont({ font, bytes }: FontFile): string {
  if (!['ttf', 'otf'].includes(font.format))
    throw new Error('This font can be downloaded, but adding it requires a TTF or OTF file.')
  const buffer = new Uint8Array(bytes).buffer
  const parsed = opentype.parse(buffer)
  if (parsed.tables.fvar)
    throw new Error('Download this variable font and choose a static TTF or OTF variant to add it.')
  const family = font.full_name.trim()
  if (
    !family ||
    family.length > 150 ||
    // Reject control characters as well as Windows path separators.
    // eslint-disable-next-line no-control-regex
    /[\\/:*?"<>|\x00-\x1f]/.test(family) ||
    family === '.' ||
    family === '..'
  ) {
    throw new Error('The font has an unsupported face name.')
  }
  if (createHash('sha256').update(bytes).digest('hex') !== font.sha256)
    throw new Error('Font checksum mismatch.')
  const dir = lensFontDir()
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${family}.${font.format}`)
  if (
    existsSync(dest) &&
    createHash('sha256').update(readFileSync(dest)).digest('hex') !== font.sha256
  ) {
    throw new Error('A different font with this name is already installed.')
  }
  writeFileSync(dest, bytes)
  writeFileSync(
    `${dest}.json`,
    JSON.stringify(
      { fontId: font.font_id, family, sha256: font.sha256, source: font.source_url },
      null,
      2,
    ),
  )
  return family
}

export function registerFontPicker(afterFontsChanged: () => void): void {
  setLensFontDir(lensFontDir())
  const sessions = new Map<number, ReturnType<typeof createPickerSession>>()
  const watched = new Set<number>()
  function getSession(sender: WebContents) {
    let session = sessions.get(sender.id)
    if (!session) {
      session = createPickerSession({
        baseUrl: fontServiceUrl(),
        apiKey: process.env.GENOFFICE_FONT_SERVICE_API_KEY,
      })
      sessions.set(sender.id, session)
      if (!watched.has(sender.id)) {
        const id = sender.id
        watched.add(id)
        sender.once('destroyed', () => {
          void sessions.get(id)?.dispose()
          sessions.delete(id)
          watched.delete(id)
        })
      }
    }
    return session
  }
  ipcMain.handle(
    'slides:font-picker',
    async (event, request: PickerRequest): Promise<PickerResult<unknown>> => {
      try {
        if (!request || typeof request.action !== 'string')
          throw new Error('Invalid font picker request.')
        if (request.action === 'dispose') {
          const previous = sessions.get(event.sender.id)
          sessions.delete(event.sender.id)
          void previous?.dispose()
          return { ok: true, value: undefined }
        }
        const session = getSession(event.sender)
        switch (request.action) {
          case 'upload':
            return { ok: true, value: await session.upload(request.bytes) }
          case 'scan':
            return { ok: true, value: await session.scan(request.imageId, request.crop) }
          case 'font':
            return { ok: true, value: await session.font(request.fontId) }
          case 'install': {
            const family = installLensFont(await session.font(request.fontId))
            afterFontsChanged()
            return { ok: true, value: family }
          }
          case 'download': {
            const file = await session.font(request.fontId)
            // eslint-disable-next-line no-control-regex
            const name = file.font.full_name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
            const result = await showSaveDialogWithMemory(dialog, undefined, {
              defaultPath: `${name}.${file.font.format}`,
              filters: [{ name: 'Font', extensions: [file.font.format] }],
            })
            if (!result.canceled && result.filePath) writeFileSync(result.filePath, file.bytes)
            return { ok: true, value: !result.canceled && !!result.filePath }
          }
          default:
            throw new Error('Unknown font picker request.')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Font service request failed.'
        return {
          ok: false,
          error:
            message === 'fetch failed'
              ? 'Cannot reach the font service. Start Lens or check GENOFFICE_FONT_SERVICE_URL.'
              : message,
        }
      }
    },
  )
}
