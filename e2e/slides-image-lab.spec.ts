import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { PNG } from 'pngjs'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'
import type { SlidesApi } from '../apps/slides/src/shared/ipc'

async function fixture(image: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'font-picker-e2e-'))
  const parts = join(dir, 'parts')
  await cp(resolve(__dirname, 'assets/font-manager-rubik'), parts, { recursive: true })
  const slide = join(parts, 'ppt/slides/slide1.xml')
  const xml = await readFile(slide, 'utf8')
  const picture =
    '<p:pic><p:nvPicPr><p:cNvPr id="100" name="Reference image"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/><a:srcRect l="10000" t="5000" r="10000" b="5000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm rot="600000"><a:off x="2743200" y="2743200"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
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

test('Image Lab previews, cancels, applies one PNG, preserves geometry and round-trips undo/save', async () => {
  test.setTimeout(180_000)
  const image = await readFile(
    resolve(__dirname, '../apps/slides/src/renderer/assets/app-icon.png'),
  )
  const output = PNG.sync.read(image)
  for (let y = 0; y < output.height; y++)
    for (let x = 0; x < output.width; x++) {
      if (x < output.width / 4 || x > (output.width * 3) / 4)
        output.data[(y * output.width + x) * 4 + 3] = 0
    }
  const transparent = PNG.sync.write(output)
  const { path } = await fixture(image)
  const originalZip = await JSZip.loadAsync(await readFile(path))
  const originalXml = await originalZip.file('ppt/slides/slide1.xml')!.async('string')
  let submits = 0
  let deletes = 0
  let polls = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Consume uploads before responding. */
    }
    expect(req.headers.authorization).toBe('Bearer local-test-token')
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/capabilities') {
      res.end('{}')
      return
    }
    const job = {
      id: 'job',
      state: 'running',
      stage: 'identifying_subject',
      artifacts: [] as unknown[],
    }
    if (req.method === 'DELETE') {
      deletes++
      res.end(JSON.stringify({ ...job, state: 'released' }))
      return
    }
    if (req.url?.includes('/artifacts/')) {
      res.setHeader('Content-Type', 'image/png')
      res.end(transparent)
      return
    }
    if (req.method === 'POST') {
      submits++
      polls = 0
      res.end(JSON.stringify(job))
      return
    }
    if (++polls > 5) {
      job.state = 'succeeded'
      job.artifacts = ['foreground', 'mask'].map((role) => ({
        role,
        url: '/v1/jobs/job/artifacts/' + role,
      }))
    }
    res.end(JSON.stringify(job))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const previousUrl = process.env.GENOFFICE_IMAGE_LAB_URL
  const previousToken = process.env.GENOFFICE_IMAGE_LAB_TOKEN
  process.env.GENOFFICE_IMAGE_LAB_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.GENOFFICE_IMAGE_LAB_TOKEN = 'local-test-token'
  const launched = await launchShell({
    onboardingSeen: true,
    videoDir: 'slides-image-lab',
    openFile: path,
  })
  try {
    const page = await waitForPageWithUrl(launched.app, 'slides/out')
    await page.waitForSelector('.stage-wrap canvas')
    const open = async () => {
      const box = (await page.locator('.stage-rel').boundingBox())!
      await page.mouse.click(box.x + (350 * box.width) / 1280, box.y + (350 * box.width) / 1280, {
        button: 'right',
      })
      await page
        .getByRole('button', { name: 'Remove Background（Preview）', exact: true })
        .last()
        .click()
    }
    await open()
    const dialog = page.getByRole('dialog', { name: 'Remove background（Preview）' })
    await expect(dialog.getByRole('status')).toContainText('Identifying')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => deletes).toBe(1)
    await open()
    await expect(dialog.getByRole('status')).toContainText('Ready to apply')
    await dialog.getByRole('button', { name: 'Original', exact: true }).click()
    await expect(dialog.locator('img')).toHaveAttribute(
      'src',
      `data:image/png;base64,${image.toString('base64')}`,
    )
    await dialog.getByRole('button', { name: 'Result', exact: true }).click()
    await expect(dialog.locator('img')).toHaveAttribute(
      'src',
      `data:image/png;base64,${transparent.toString('base64')}`,
    )
    await page.screenshot({ path: screenshotPath('image-lab-preview-light') })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.screenshot({ path: screenshotPath('image-lab-preview-dark') })
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(submits).toBe(2)
    const undone = await page.evaluate(() =>
      (window as unknown as { slidesApi: SlidesApi }).slidesApi.undo(),
    )
    expect(undone?.[0]?.nodes.find((n) => n.type === 'picture')).toMatchObject({
      dataUrl: `data:image/png;base64,${image.toString('base64')}`,
    })
    const redone = await page.evaluate(() =>
      (window as unknown as { slidesApi: SlidesApi }).slidesApi.redo(),
    )
    expect(redone?.[0]?.nodes.find((n) => n.type === 'picture')).toMatchObject({
      dataUrl: `data:image/png;base64,${transparent.toString('base64')}`,
    })
    const saved = await page.evaluate(() =>
      (window as unknown as { slidesApi: SlidesApi }).slidesApi.save(),
    )
    expect(saved.ok).toBe(true)
    const zip = await JSZip.loadAsync(await readFile(path))
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(xml.match(/<a:xfrm rot="600000">.*?<\/a:xfrm>/)?.[0]).toBe(
      originalXml.match(/<a:xfrm rot="600000">.*?<\/a:xfrm>/)?.[0],
    )
    expect(xml).toContain('<a:srcRect l="10000" t="5000" r="10000" b="5000"/>')
    const images = await Promise.all(
      Object.keys(zip.files)
        .filter((name) => name.startsWith('ppt/media/') && !zip.files[name]!.dir)
        .map((name) => zip.file(name)!.async('nodebuffer')),
    )
    expect(images.some((bytes) => bytes.equals(transparent))).toBe(true)
    const reopened = await page.evaluate(
      (file) => (window as unknown as { slidesApi: SlidesApi }).slidesApi.openPptxPath(file, 1280),
      path,
    )
    const picture = reopened!.slides[0]!.nodes.find((node) => node.type === 'picture')!
    expect(picture).toMatchObject({
      dataUrl: `data:image/png;base64,${transparent.toString('base64')}`,
    })
    const stale = await page.evaluate(
      async ({ sourceId, base64 }) => {
        const api = (window as unknown as { slidesApi: SlidesApi }).slidesApi
        const prepared = await api.imageLab({
          action: 'prepare',
          requestId: 'changed-picture',
          slideIndex: 0,
          sourceId,
        })
        if (!prepared.ok) throw new Error(prepared.error)
        await api.replacePictureBytes({
          slideIndex: 0,
          sourceId,
          base64,
          ext: 'png',
          keepSrcRect: true,
        })
        return api.imageLab({ action: 'apply', requestId: 'changed-picture' })
      },
      { sourceId: picture.sourceId, base64: image.toString('base64') },
    )
    expect(stale).toMatchObject({
      ok: false,
      error: expect.stringContaining('original picture changed'),
    })
    const switched = await page.evaluate(async (file) => {
      const api = (window as unknown as { slidesApi: SlidesApi }).slidesApi
      const opened = await api.openPptxPath(file, 1280)
      const sourceId = opened!.slides[0]!.nodes.find((node) => node.type === 'picture')!.sourceId
      const prepared = await api.imageLab({
        action: 'prepare',
        requestId: 'changed-document',
        slideIndex: 0,
        sourceId,
      })
      if (!prepared.ok) throw new Error(prepared.error)
      await api.newBlank(1280)
      return api.imageLab({ action: 'apply', requestId: 'changed-document' })
    }, path)
    expect(switched).toMatchObject({ ok: false })
  } finally {
    await closeAndSaveVideo(launched, 'image-lab')
    await new Promise<void>((done) => server.close(() => done()))
    if (previousUrl === undefined) delete process.env.GENOFFICE_IMAGE_LAB_URL
    else process.env.GENOFFICE_IMAGE_LAB_URL = previousUrl
    if (previousToken === undefined) delete process.env.GENOFFICE_IMAGE_LAB_TOKEN
    else process.env.GENOFFICE_IMAGE_LAB_TOKEN = previousToken
  }
})

test('Image Lab live service removes a real photo background and saves transparent pixels', async () => {
  test.skip(
    !process.env.GENOFFICE_IMAGE_LAB_LIVE_IMAGE,
    'Set a local photo path to run real inference.',
  )
  test.setTimeout(480_000)
  const image = await readFile(process.env.GENOFFICE_IMAGE_LAB_LIVE_IMAGE!)
  const { path } = await fixture(image)
  const launched = await launchShell({
    onboardingSeen: true,
    videoDir: 'slides-image-lab-live',
    openFile: path,
    lang: 'zh',
  })
  try {
    const page = await waitForPageWithUrl(launched.app, 'slides/out')
    await page.waitForSelector('.stage-wrap canvas')
    const box = (await page.locator('.stage-rel').boundingBox())!
    await page.mouse.click(box.x + (350 * box.width) / 1280, box.y + (350 * box.width) / 1280, {
      button: 'right',
    })
    await page
      .getByRole('button', { name: /去除背景（预览版）/, exact: true })
      .last()
      .click()
    const dialog = page.locator('.image-lab-dialog')
    await expect(dialog.getByRole('status')).toContainText('处理完成', { timeout: 420_000 })
    const src = await dialog.locator('img').getAttribute('src')
    const bytes = Buffer.from(src!.split(',')[1]!, 'base64')
    const pixels = PNG.sync.read(bytes)
    const source = PNG.sync.read(image)
    expect([pixels.width, pixels.height]).toEqual([source.width, source.height])
    let transparent = 0,
      opaque = 0,
      soft = 0
    for (let i = 3; i < pixels.data.length; i += 4) {
      if (pixels.data[i] === 0) transparent++
      else if (pixels.data[i] === 255) opaque++
      else soft++
    }
    expect(transparent).toBeGreaterThan(0)
    expect(opaque).toBeGreaterThan(0)
    expect(soft).toBeGreaterThan(0)
    await page.screenshot({ path: screenshotPath('image-lab-live-preview') })
    await dialog.locator('.modal-actions button.primary').click()
    await expect(dialog).toHaveCount(0)
    const saved = await page.evaluate(() =>
      (window as unknown as { slidesApi: SlidesApi }).slidesApi.save(),
    )
    expect(saved.ok).toBe(true)
    const zip = await JSZip.loadAsync(await readFile(path))
    const images = await Promise.all(
      Object.keys(zip.files)
        .filter((name) => name.startsWith('ppt/media/') && !zip.files[name]!.dir)
        .map((name) => zip.file(name)!.async('nodebuffer')),
    )
    expect(images.some((image) => image.equals(bytes))).toBe(true)
  } finally {
    await closeAndSaveVideo(launched, 'image-lab-live')
  }
})
