import { app, ipcMain, net } from 'electron'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getSlideNotes } from '@genoffice/pptx-engine'
import { sessions, viewerWcIds } from './session-state'
import type { Session } from './session-state'
import { judgeFollow } from './voice-follow-model'
import { followSettings, jevKey, deepseekConfig, whisperPaths } from './ai-service-settings'
import { validateFollowState } from '../shared/voice-follow'
import type { FollowApi, FollowCard } from '../shared/voice-follow'

function fingerprint(session: Session): string {
  const notes = session.opened.deck.slides.map((s) => getSlideNotes(session.opened.archive, s.path))
  return createHash('sha256')
    .update(JSON.stringify([session.opened.deck, notes]))
    .digest('hex')
}

export function registerVoiceFollowIpc(): void {
  const prepared = new Map<
    number,
    { token: string; session: Session; fingerprint: string; cards: FollowCard[] }
  >()
  const requests = new Map<number, Map<string, AbortController>>()
  const audio = new Map<number, AbortController>()
  const watched = new Set<number>()
  const cancel = (id: number) => {
    requests.get(id)?.forEach((c) => c.abort())
    requests.delete(id)
    audio.get(id)?.abort()
    audio.delete(id)
    prepared.delete(id)
  }
  const check = (event: Electron.IpcMainInvokeEvent): Session => {
    const id = event.sender.id
    const session = sessions.get(id)
    if (!session || viewerWcIds.has(id)) throw new Error('请在演讲者窗口打开 PPT。')
    if (!watched.has(id)) {
      watched.add(id)
      event.sender.once('destroyed', () => {
        cancel(id)
        watched.delete(id)
      })
    }
    return session
  }
  ipcMain.handle('slides:follow-status', (e) => {
    check(e)
    return followSettings()
  })
  ipcMain.handle('slides:follow-prepare', (e, cards: FollowCard[]) => {
    const session = check(e)
    validateFollowState({
      cards,
      current: cards?.[0]?.id ?? '',
      previous: null,
      text: 'prepare',
      recent: [],
    })
    if (cards.some((c) => c.index >= session.opened.deck.slides.length))
      throw new Error('页面已变化。')
    cancel(e.sender.id)
    const token = randomUUID()
    prepared.set(e.sender.id, { token, session, cards, fingerprint: fingerprint(session) })
    return token
  })
  ipcMain.handle('slides:follow-cancel', (e) => {
    cancel(e.sender.id)
  })
  ipcMain.handle('slides:follow-judge', async (e, request: Parameters<FollowApi['judge']>[0]) => {
    const session = check(e)
    const snapshot = prepared.get(e.sender.id)
    if (
      !snapshot ||
      snapshot.token !== request?.token ||
      snapshot.session !== session ||
      snapshot.fingerprint !== fingerprint(session)
    )
      throw new Error('文档已变化，请重新开始跟随。')
    if (
      !['jev', 'deepseek-flash', 'deepseek-v4-pro'].includes(request.engine) ||
      typeof request.id !== 'string' ||
      request.id.length > 100
    )
      throw new Error('无效判断请求。')
    const state = { ...request.state, cards: snapshot.cards }
    validateFollowState(state)
    const active = requests.get(e.sender.id) ?? new Map<string, AbortController>()
    if (active.has(request.engine)) throw new Error('请等待当前判断完成。')
    const controller = new AbortController()
    active.set(request.engine, controller)
    requests.set(e.sender.id, active)
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const config = request.engine === 'jev' ? { key: jevKey() } : deepseekConfig()
      const result = await judgeFollow(
        request.engine,
        state,
        config,
        controller.signal,
        (url, init) => net.fetch(url as string, init),
      )
      if (
        controller.signal.aborted ||
        prepared.get(e.sender.id) !== snapshot ||
        sessions.get(e.sender.id) !== session ||
        snapshot.fingerprint !== fingerprint(session)
      )
        result.error = '请求已过期或文档已变化。'
      return result
    } finally {
      clearTimeout(timeout)
      if (active.get(request.engine) === controller) active.delete(request.engine)
    }
  })
  ipcMain.handle('slides:follow-transcribe', async (e, wav: Uint8Array) => {
    const session = check(e)
    const sessionFingerprint = fingerprint(session)
    const { binary, model } = whisperPaths()
    if (!binary || !model || !existsSync(binary) || !existsSync(model))
      throw new Error('请先选择 whisper-cli 和多语言模型。文字模式无需这些配置。')
    if (
      !(wav instanceof Uint8Array) ||
      wav.length < 44 ||
      wav.length > 500000 ||
      Buffer.from(wav.subarray(0, 4)).toString() !== 'RIFF'
    )
      throw new Error('音频片段无效。')
    if (audio.has(e.sender.id)) throw new Error('上一段语音仍在识别。')
    const controller = new AbortController()
    audio.set(e.sender.id, controller)
    const timeout = setTimeout(() => controller.abort(), 60000)
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'genoffice-speech-'))
      const input = join(dir, 'speech.wav')
      const output = join(dir, 'transcript')
      await writeFile(input, wav)
      await promisify(execFile)(
        binary,
        [
          '-m',
          model,
          '-f',
          input,
          '-l',
          'zh',
          '--prompt',
          (prepared.get(e.sender.id)?.cards ?? [])
            .map((c) => [c.title, c.hint, c.text].join('，'))
            .join('。')
            .slice(0, 600),
          '-otxt',
          '-of',
          output,
          '-nt',
          '-np',
        ],
        { signal: controller.signal, maxBuffer: 2e6 },
      )
      if (
        controller.signal.aborted ||
        sessions.get(e.sender.id) !== session ||
        fingerprint(session) !== sessionFingerprint
      )
        throw new Error('stale audio')
      return (await readFile(`${output}.txt`, 'utf8')).replace(/\[[^\]]*\]/g, '').trim()
    } catch {
      throw new Error(
        controller.signal.aborted
          ? '语音识别已取消或超时。'
          : '本地语音识别失败，请检查 Whisper 程序和模型。',
      )
    } finally {
      clearTimeout(timeout)
      if (audio.get(e.sender.id) === controller) audio.delete(e.sender.id)
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  })
  app.once('before-quit', () => {
    for (const id of watched) cancel(id)
  })
}
