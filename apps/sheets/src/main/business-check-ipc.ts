import { ipcMain, net } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { checkRequestSchema } from '../shared/business-check'
import {
  deepseekConfig,
  followSettings,
  jevKey,
} from '../../../slides/src/main/ai-service-settings'
import { judgeBusinessRecord } from './business-check-model'

export function registerBusinessCheckIpc(validate: (event: IpcMainInvokeEvent) => unknown): void {
  const pending = new Map<number, Map<string, AbortController>>()
  ipcMain.handle('sheets:business-settings', (event) => {
    validate(event)
    const { jevReady, deepseekReady } = followSettings()
    return { jevReady, deepseekReady }
  })
  ipcMain.handle('sheets:business-cancel', (event, id: unknown) => {
    validate(event)
    if (typeof id === 'string') pending.get(event.sender.id)?.get(id)?.abort()
  })
  ipcMain.handle('sheets:business-judge', async (event, raw: unknown) => {
    validate(event)
    const request = checkRequestSchema.parse(raw)
    let requests = pending.get(event.sender.id)
    if (!requests) {
      requests = new Map()
      pending.set(event.sender.id, requests)
      event.sender.once('destroyed', () => {
        for (const controller of pending.get(event.sender.id)?.values() ?? []) controller.abort()
        pending.delete(event.sender.id)
      })
    }
    if (requests.size >= 2 || requests.has(request.id)) throw new Error('已有检查正在进行。')
    const controller = new AbortController()
    requests.set(request.id, controller)
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const config = request.engine === 'jev' ? { key: jevKey() } : deepseekConfig()
      return await judgeBusinessRecord(
        request.engine,
        request.record,
        config,
        controller.signal,
        net.fetch as typeof fetch,
      )
    } finally {
      clearTimeout(timer)
      requests.delete(request.id)
    }
  })
}
