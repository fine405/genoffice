/** @vitest-environment node */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ dir: '', dialog: vi.fn(), available: true }))
vi.mock('electron', () => ({
  app: { getPath: () => mock.dir },
  dialog: { showOpenDialog: mock.dialog },
  safeStorage: {
    isEncryptionAvailable: () => mock.available,
    encryptString: (key: string) => Buffer.from(`encrypted:${key}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
}))
import {
  chooseWhisper,
  deepseekConfig,
  followSettings,
  jevKey,
  saveJevKey,
} from '../src/main/ai-service-settings'
const save = (name: string, value: unknown) =>
  writeFileSync(join(mock.dir, name), JSON.stringify(value))
beforeEach(() => {
  mock.dir = mkdtempSync(join(tmpdir(), 'global-services-'))
  mock.available = true
  mock.dialog.mockReset()
  vi.stubEnv('TYPESAFE_API_KEY', '')
  vi.stubEnv('DEEPSEEK_API_KEY', 'environment-must-not-override')
})
afterEach(() => {
  rmSync(mock.dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
it('uses the global DeepSeek provider and rereads changes, ignoring sidebar and environment keys', () => {
  save('slides-voice-follow.json', { deepseek: 'legacy-key' })
  save('ai-services.json', { deepseek: 'another-legacy-key' })
  expect(deepseekConfig().key).toBe('')
  save('ai-settings.json', {
    provider: 'genspark',
    providers: { deepseek: { apiKey: 'global-key', baseUrl: 'https://gateway.example/v1' } },
  })
  expect(deepseekConfig()).toEqual({ key: 'global-key', baseUrl: 'https://gateway.example/v1' })
  save('ai-settings.json', { providers: { deepseek: { apiKey: 'updated-key' } } })
  expect(deepseekConfig().key).toBe('updated-key')
})
it('preserves earlier Jev/speech settings when saving centrally, but discards the separate DeepSeek key', () => {
  save('slides-voice-follow.json', {
    jev: Buffer.from('encrypted:previous-jev').toString('base64'),
    binary: '/previous/whisper-cli',
    model: '/previous/model.bin',
    deepseek: 'legacy-key',
  })
  expect(jevKey()).toBe('previous-jev')
  saveJevKey('new-jev')
  const stored = JSON.parse(readFileSync(join(mock.dir, 'ai-services.json'), 'utf8'))
  expect(stored).toMatchObject({ binary: '/previous/whisper-cli', model: '/previous/model.bin' })
  expect(stored.deepseek).toBeUndefined()
  expect(stored.jev).not.toContain('new-jev')
  expect(jevKey()).toBe('new-jev')
  expect(followSettings()).not.toHaveProperty('jev')
  expect(followSettings()).not.toHaveProperty('apiKey')
})
it('saves both speech selections globally and retains them on dialog cancellation', async () => {
  const binary = join(mock.dir, 'whisper-cli'),
    model = join(mock.dir, 'multilingual.bin')
  writeFileSync(binary, 'executable fixture')
  writeFileSync(model, 'model fixture')
  mock.dialog.mockResolvedValueOnce({ canceled: false, filePaths: [binary] })
  await chooseWhisper('binary')
  mock.dialog.mockResolvedValueOnce({ canceled: false, filePaths: [model] })
  expect(await chooseWhisper('model')).toMatchObject({
    whisperReady: true,
    whisperBinaryPath: binary,
    whisperModelPath: model,
  })
  mock.dialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
  expect((await chooseWhisper('model')).whisperModelPath).toBe(model)
  await expect(chooseWhisper('unexpected')).rejects.toThrow('无效配置')
})
it('rejects empty keys or unavailable encryption without overwriting saved configuration', () => {
  saveJevKey('original')
  expect(() => saveJevKey(' ')).toThrow('API Key')
  mock.available = false
  expect(() => saveJevKey('replacement')).toThrow('系统加密存储不可用')
  mock.available = true
  expect(jevKey()).toBe('original')
})
