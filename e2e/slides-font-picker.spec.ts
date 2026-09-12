import { test, expect, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'
import type { SlidesApi } from '../apps/slides/src/shared/ipc'

async function fixture(image: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'font-picker-e2e-'))
  const parts = join(dir, 'parts')
  await cp(resolve(__dirname, 'assets/font-manager-rubik'), parts, { recursive: true })
  const slide = join(parts, 'ppt/slides/slide1.xml')
  const xml = await readFile(slide, 'utf8')
  const picture =
    '<p:pic><p:nvPicPr><p:cNvPr id="100" name="Reference image"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="2743200" y="2743200"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
  await writeFile(slide, xml.replace('</p:spTree>', picture + '</p:spTree>'))
  const rels = join(parts, 'ppt/slides/_rels/slide1.xml.rels')
  await writeFile(
    rels,
    (await readFile(rels, 'utf8')).replace(
      '</Relationships>',
      '<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/reference.png"/></Relationships>',
    ),
  )
  await mkdir(join(parts, 'ppt/media'), { recursive: true })
  await writeFile(join(parts, 'ppt/media/reference.png'), image)
  const contentTypes = join(parts, '[Content_Types].xml')
  await writeFile(
    contentTypes,
    (await readFile(contentTypes, 'utf8')).replace(
      '</Types>',
      '<Default Extension="png" ContentType="image/png"/></Types>',
    ),
  )
  const path = join(dir, 'font-picker.pptx')
  execFileSync('zip', ['-X', '-q', '-r', path, '.'], { cwd: parts })
  return { path, dir }
}

async function openPicker(page: Page) {
  await page.locator('.rb-font-name button').click()
  await page.getByRole('button', { name: 'Find font from image…', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
}
async function scan(page: Page) {
  await page.getByRole('button', { name: 'Identify font', exact: true }).click()
  await expect(page.locator('.font-picker-match')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Add to GenOffice', exact: true })).toBeEnabled()
}
async function savedXml(page: Page, path: string) {
  const result = await page.evaluate(() =>
    (window as unknown as { slidesApi: SlidesApi }).slidesApi.save(),
  )
  expect(result.ok).toBe(true)
  return (await JSZip.loadAsync(await readFile(path)))
    .file('ppt/slides/slide1.xml')!
    .async('string')
}

test('font picker imports document regions, installs actual fonts, applies, undoes and reopens', async () => {
  test.setTimeout(180_000)
  const bytes = await readFile(resolve(__dirname, '../packages/ui/src/fonts/Carlito-Regular.ttf'))
  const image = await readFile(
    resolve(__dirname, '../apps/slides/src/renderer/assets/app-icon.png'),
  )
  const { path, dir } = await fixture(image)
  const scans: unknown[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    const route = req.url!
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'DELETE') {
      res.writeHead(204).end()
      return
    }
    if (route === '/api/v1/images') {
      res.end(JSON.stringify({ image_id: 'image-1', input_image: { width: 1024, height: 1024 } }))
      return
    }
    if (route === '/api/v1/images/image-1/file') {
      res.setHeader('Content-Type', 'image/png')
      res.end(image)
      return
    }
    if (route === '/api/v1/scans') {
      scans.push(JSON.parse(body.toString()))
      res.end(
        JSON.stringify({
          regions: [
            {
              id: 'r1',
              number: 1,
              text: 'Rubik headline',
              box: { left: 0, top: 0, width: 1024, height: 1024 },
              font_matches: [
                {
                  family_id: 'carlito',
                  name: 'Carlito',
                  score: 0.9,
                  fonts: [
                    {
                      font_id: 'carlito-regular',
                      full_name: 'Lens Test Regular',
                      weight: 400,
                      style: 'normal',
                    },
                  ],
                },
              ],
            },
          ],
        }),
      )
      return
    }
    if (route === '/api/v1/fonts/carlito-regular') {
      res.end(
        JSON.stringify({
          font_id: 'carlito-regular',
          family_id: 'carlito',
          family: 'Carlito',
          full_name: 'Lens Test Regular',
          style: 'normal',
          weight: 400,
          format: 'ttf',
          size_bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          source_url: 'https://example.test/carlito.ttf',
        }),
      )
      return
    }
    if (route === '/api/v1/fonts/carlito-regular/file') {
      res.setHeader('Content-Type', 'font/ttf')
      res.end(bytes)
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const previousUrl = process.env.GENOFFICE_FONT_SERVICE_URL
  process.env.GENOFFICE_FONT_SERVICE_URL = `http://127.0.0.1:${address.port}/api/v1`
  let launched = await launchShell({
    onboardingSeen: true,
    videoDir: 'slides-font-picker',
    openFile: path,
  })
  try {
    let page = await waitForPageWithUrl(launched.app, 'slides/out')
    await page.waitForSelector('.stage-wrap canvas')
    // No text selected: discovery remains available, and application is not offered.
    await openPicker(page)
    await expect(page.getByRole('button', { name: 'Add and apply', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Pick from document', exact: true }).click()
    await expect(page.locator('.font-picker-gallery button')).toHaveCount(1)
    await page.locator('.font-picker-gallery button').click()
    await expect(page.locator('.font-picker-image > img')).toBeVisible()
    const box = (await page.locator('.font-picker-image').boundingBox())!
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 8 })
    await page.mouse.up()
    await scan(page)
    expect(scans[0]).toMatchObject({ crop_box: { left: 205, top: 205, width: 512, height: 512 } })
    const downloadPath = join(dir, 'download.ttf')
    await launched.app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: destination,
      })) as typeof dialog.showSaveDialog
    }, downloadPath)
    await page.getByRole('button', { name: 'Download font', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Font downloaded.')
    expect(await readFile(downloadPath)).toEqual(bytes)
    await page.getByRole('button', { name: 'Add to GenOffice', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Font added to GenOffice.')
    await page.screenshot({ path: screenshotPath('font-picker-light') })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.screenshot({ path: screenshotPath('font-picker-dark') })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    const stage = (await page.locator('.stage-rel').boundingBox())!
    // The fixture is 13 1/3 inches wide, with its title at (1 in, 1 in).
    const scale = stage.width / 1280
    // The image context menu starts with the original picture and no text target.
    await page.mouse.click(stage.x + 350 * scale, stage.y + 350 * scale, { button: 'right' })
    await page.getByText('Identify image font…', { exact: true }).click()
    await expect(page.locator('.font-picker-image > img')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add and apply', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Preserve a substring selection through the modal; surrounding text retains its font.
    await page.mouse.dblclick(stage.x + 130 * scale, stage.y + 130 * scale)
    const editor = page.locator('.stage-rel [contenteditable=true]')
    await expect(editor).toBeVisible()
    await editor.evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const start = node.textContent?.indexOf('Rubik') ?? -1
        if (start < 0) continue
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, start + 5)
        root.focus()
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
        return
      }
      throw new Error('Fixture text missing')
    })
    await openPicker(page)
    await expect(page.locator('.font-picker-results input')).toHaveValue('Rubik')
    await page
      .locator('input[type=file]')
      .setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: image })
    await expect(page.locator('.font-picker-image > img')).toBeVisible()
    await scan(page)
    await page.getByRole('button', { name: 'Add and apply', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(editor).toHaveCount(0)
    const partial = await savedXml(page, path)
    expect(partial).toMatch(/typeface="Lens Test Regular"[^]*?<a:t>Rubik<\/a:t>/)
    expect(partial).toContain('typeface="Rubik"')
    await page.keyboard.press('Meta+z')
    await expect.poll(() => savedXml(page, path)).not.toContain('typeface="Lens Test Regular"')
    await page.mouse.click(stage.x + 130 * scale, stage.y + 130 * scale)
    await page.screenshot({ path: screenshotPath('font-picker-target') })
    await openPicker(page)
    await expect(page.getByRole('button', { name: 'Add and apply', exact: true })).toBeVisible()
    await page
      .locator('input[type=file]')
      .setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: image })
    await expect(page.locator('.font-picker-image > img')).toBeVisible()
    await scan(page)
    await page.getByRole('button', { name: 'Add and apply', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.rb-font-input')).toHaveValue('Lens Test Regular')
    // Save then undo and redo through the real editor, verifying OOXML, not just preview CSS.
    expect(await savedXml(page, path)).toContain('typeface="Lens Test Regular"')
    await page.keyboard.press('Meta+z')
    expect(await savedXml(page, path)).not.toContain('typeface="Lens Test Regular"')
    await page.keyboard.press('Meta+Shift+z')
    expect(await savedXml(page, path)).toContain('typeface="Lens Test Regular"')
    const userDataDir = launched.userDataDir
    await closeAndSaveVideo(launched, 'slides-font-picker')
    launched = await launchShell({
      userDataDir,
      onboardingSeen: true,
      videoDir: 'slides-font-picker-reopen',
      openFile: path,
    })
    page = await waitForPageWithUrl(launched.app, 'slides/out')
    await page.waitForSelector('.stage-wrap canvas')
    const available = await page.evaluate(async () => {
      const api = (window as unknown as { slidesApi: SlidesApi }).slidesApi
      return { catalog: await api.fontCatalog(), faces: await api.privateFontFaces() }
    })
    expect(available.catalog.some((f) => f.family === 'Lens Test Regular' && f.installed)).toBe(
      true,
    )
    expect(available.faces.some((f) => f.family === 'Lens Test Regular')).toBe(true)
  } finally {
    await closeAndSaveVideo(launched, 'slides-font-picker-final')
    server.close()
    if (previousUrl === undefined) delete process.env.GENOFFICE_FONT_SERVICE_URL
    else process.env.GENOFFICE_FONT_SERVICE_URL = previousUrl
  }
})
