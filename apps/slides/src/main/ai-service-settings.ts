import { app, dialog, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import type { AiServiceSettings } from '../shared/voice-follow'

interface Stored {
  jev?: string
  binary?: string
  model?: string
}
const file = () => join(app.getPath('userData'), 'ai-services.json')
function readConfig(): Stored {
  try {
    const source = existsSync(file())
      ? file()
      : join(app.getPath('userData'), 'slides-voice-follow.json')
    const { jev, binary, model } = JSON.parse(readFileSync(source, 'utf8'))
    // Preserve earlier Jev/speech settings; never import the old DeepSeek override.
    return { jev, binary, model }
  } catch {
    return {}
  }
}
function saveConfig(patch: Partial<Stored>): void {
  writeFileSync(file(), JSON.stringify({ ...readConfig(), ...patch }), { mode: 0o600 })
}
export function deepseekConfig(): { key: string; baseUrl?: string } {
  let provider: { apiKey?: string; baseUrl?: string } = {}
  try {
    provider =
      JSON.parse(readFileSync(join(app.getPath('userData'), 'ai-settings.json'), 'utf8')).providers
        ?.deepseek ?? {}
  } catch {
    /* No saved provider. */
  }
  return { key: provider.apiKey || '', ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}) }
}
export function jevKey(): string {
  const saved = readConfig().jev
  if (saved && safeStorage.isEncryptionAvailable())
    return safeStorage.decryptString(Buffer.from(saved, 'base64'))
  return process.env.TYPESAFE_API_KEY || ''
}
export function saveJevKey(key: string): void {
  if (typeof key !== 'string' || !key.trim() || key.length > 4096) throw new Error('API Key 无效。')
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('系统加密存储不可用，请使用环境变量配置密钥。')
  saveConfig({ jev: safeStorage.encryptString(key.trim()).toString('base64') })
}
export function whisperPaths(): { binary: string; model: string } {
  const saved = readConfig()
  return {
    binary:
      saved.binary ||
      process.env.WHISPER_CLI_PATH ||
      ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find(existsSync) ||
      '',
    model:
      saved.model ||
      process.env.WHISPER_MODEL_PATH ||
      join(homedir(), '.cache/genoffice/whisper/ggml-small.bin'),
  }
}
export function followSettings(): AiServiceSettings {
  const { binary, model } = whisperPaths()
  return {
    jevReady: Boolean(jevKey()),
    deepseekReady: Boolean(deepseekConfig().key),
    whisperReady: Boolean(binary && model && existsSync(binary) && existsSync(model)),
    whisperModel: model ? basename(model) : '',
    whisperBinaryPath: binary,
    whisperModelPath: model,
  }
}
export async function chooseWhisper(kind: string): Promise<AiServiceSettings> {
  if (kind !== 'binary' && kind !== 'model') throw new Error('无效配置。')
  const result = await dialog.showOpenDialog({
    title: kind === 'binary' ? '选择 whisper-cli 程序' : '选择 Whisper 多语言模型 (.bin)',
    properties: ['openFile'],
  })
  if (!result.canceled && result.filePaths[0]) saveConfig({ [kind]: result.filePaths[0] })
  return followSettings()
}
