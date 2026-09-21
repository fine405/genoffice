import { describe, it, expect, vi } from 'vitest'
import { BusinessCheckController, validateConfig } from '../src/renderer/business-check/controller'
import type { CheckConfig } from '../src/renderer/business-check/controller'
import { applicability } from '../src/shared/business-check'
import type { CheckResult, CheckRecord } from '../src/shared/business-check'
import { judgeBusinessRecord } from '../src/main/business-check-model'

const record: CheckRecord = {
  row: 1,
  project: '北辰',
  status: '已完成',
  progress: '客户尚未验收',
  feedback: '',
}
const config: CheckConfig = {
  workbookId: 'book',
  sheetId: 'sheet',
  sheetName: '台账',
  range: 'A1:D4',
  headerRow: 0,
  columns: { project: 0, status: 1, progress: 2, feedback: 3 },
  engines: ['jev', 'deepseek-flash'],
}
function fixture() {
  const cells: Record<string, string> = {
    A2: '北辰',
    B2: '已完成',
    C2: '客户尚未验收',
    A3: '远山',
    B3: '进行中',
    C3: '测试中',
  }
  const judge = vi.fn(
    async (request) =>
      ({
        engine: request.engine,
        model: request.engine,
        elapsedMs: 20,
        label: 'inconsistent',
      }) as CheckResult,
  )
  const load = vi.fn(async () => true)
  const cancel = vi.fn(async () => {})
  const navigate = vi.fn(async () => {})
  const controller = new BusinessCheckController({
    currentWorkbook: () => 'book',
    aiBusy: () => false,
    load,
    read: (_sheet, addresses) =>
      Object.fromEntries(addresses.map((a) => [a, { value: cells[a] ?? null }])),
    navigate,
    api: { judge, cancel, settings: async () => ({ jevReady: true, deepseekReady: true }) },
  })
  return { controller, cells, judge, load, cancel, navigate }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('business check snapshots and lifecycle', () => {
  it('counts applicability in code, skips empty rows and sends identical snapshots to both engines', async () => {
    const f = fixture()
    await f.controller.prepare(config)
    expect(f.controller.snapshot()).toMatchObject({
      phase: 'ready',
      empty: 1,
      rows: [{ applicability: 'eligible' }, { applicability: 'not-applicable' }],
    })
    await f.controller.run()
    expect(f.judge).toHaveBeenCalledTimes(2)
    expect(f.judge.mock.calls[0]![0].record).toEqual(f.judge.mock.calls[1]![0].record)
    expect(f.load).toHaveBeenCalledTimes(4)
    expect(f.controller.snapshot().phase).toBe('completed')
  })
  it('does not invoke models for empty, non-applicable or unknown status', async () => {
    const f = fixture()
    f.cells.B2 = '已交付'
    await f.controller.prepare(config)
    await f.controller.run()
    expect(f.judge).not.toHaveBeenCalled()
    expect(f.controller.snapshot().rows[0]!.applicability).toBe('missing')
    expect(applicability({ ...record, project: '', status: '', progress: '' })).toBe('empty')
  })
  it('keeps source snapshot stale during late responses, and rechecks only the edited row', async () => {
    const f = fixture()
    await f.controller.prepare(config)
    const wait = deferred<CheckResult>()
    f.judge.mockImplementationOnce(() => wait.promise)
    const run = f.controller.run()
    f.cells.C2 = '客户已签署本次验收通过单'
    f.controller.changed('sheet', { startRow: 1, endRow: 1, startColumn: 2, endColumn: 2 })
    wait.resolve({ engine: 'jev', model: 'jev', elapsedMs: 50, label: 'inconsistent' })
    await run
    expect(f.controller.snapshot().rows[0]).toMatchObject({
      stale: true,
      record: { progress: '客户尚未验收' },
    })
    await f.controller.run(1)
    expect(f.judge).toHaveBeenCalledTimes(4)
    expect(f.controller.snapshot().rows[0]).toMatchObject({
      stale: false,
      record: { progress: f.cells.C2 },
    })
  })
  it('cancellation keeps usage but never marks an unfinished result complete or starts another row', async () => {
    const f = fixture()
    f.cells.B3 = '已完成'
    await f.controller.prepare(config)
    const wait = deferred<CheckResult>()
    f.judge.mockImplementation(() => wait.promise)
    const run = f.controller.run()
    f.controller.stop()
    expect(f.cancel).toHaveBeenCalledTimes(2)
    wait.resolve({
      engine: 'jev',
      model: 'jev',
      elapsedMs: 50,
      label: 'consistent',
      usage: { input: 100, output: 10, cacheHit: null, costMin: 0.0000042, costMax: 0.0000042 },
    })
    await run
    expect(f.judge).toHaveBeenCalledTimes(2)
    expect(f.controller.snapshot()).toMatchObject({
      phase: 'cancelled',
      busy: false,
      rows: [{ state: 'cancelled' }, { state: 'cancelled' }],
    })
    expect(f.controller.snapshot().attempts).toHaveLength(2)
  })
  it('structure changes disable navigation; changes on other sheets or columns do not stale rows', async () => {
    const f = fixture()
    await f.controller.prepare(config)
    f.controller.changed('another', undefined, true)
    f.controller.changed('sheet', { startRow: 1, endRow: 1, startColumn: 6, endColumn: 6 })
    expect(f.controller.snapshot().rows[0]!.stale).toBe(false)
    await f.controller.locate(1)
    expect(f.navigate).toHaveBeenCalledTimes(1)
    f.controller.changed('sheet', undefined, true)
    await f.controller.locate(1)
    expect(f.navigate).toHaveBeenCalledTimes(1)
    expect(f.controller.snapshot().structuralStale).toBe(true)
  })
  it('read errors and edits during loading never become empty successful reports', async () => {
    const f = fixture()
    f.load.mockResolvedValue(false)
    await f.controller.prepare(config)
    expect(f.controller.snapshot().phase).toBe('failed')
    expect(f.judge).not.toHaveBeenCalled()
    f.load.mockResolvedValue(true)
    const wait = deferred<boolean>()
    f.load.mockImplementationOnce(() => wait.promise)
    const preparation = f.controller.prepare(config)
    f.controller.changed('sheet')
    wait.resolve(true)
    await preparation
    expect(f.controller.snapshot().phase).toBe('failed')
  })
  it('rejects unbounded and overlapping mappings and reads offscreen rows in bounded chunks', async () => {
    expect(() => validateConfig({ ...config, range: 'A1:D1048576' })).toThrow()
    expect(() => validateConfig({ ...config, columns: { ...config.columns, status: 0 } })).toThrow()
    const f = fixture()
    f.cells.A205 = '远端项目'
    f.cells.B205 = '已完成'
    await f.controller.prepare({ ...config, range: 'A1:D205' })
    await f.controller.run()
    expect(f.load).toHaveBeenCalledTimes(12)
    expect(f.judge).toHaveBeenCalledTimes(4)
    expect(f.judge.mock.calls[2]![0].record.row).toBe(204)
  })
  it('suppresses duplicate row rechecks and guards reopening during pending requests', async () => {
    const f = fixture()
    await f.controller.prepare(config)
    const wait = deferred<CheckResult>()
    f.judge.mockImplementation(() => wait.promise)
    const run = f.controller.run(1)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await f.controller.run(1)
    f.controller.reset()
    wait.resolve({ engine: 'jev', model: 'jev', elapsedMs: 10, label: 'consistent' })
    await run
    expect(f.controller.snapshot().config).toBeNull()
    expect(f.controller.snapshot().attempts).toHaveLength(0)
  })
})

describe('model adapters', () => {
  const response = (data: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(data))) as unknown as typeof fetch
  it('uses Choice with shared rule and validates the distribution', async () => {
    const fetcher = response({
      model: 'jev-1.13.0',
      usage: { input_tokens: 500, output_tokens: 30 },
      answers: {
        acceptance: {
          type: 'choice',
          choice: 'inconsistent',
          confidence: 0.9,
          probabilities: { consistent: 0.05, inconsistent: 0.9, insufficient: 0.05 },
        },
      },
    })
    const result = await judgeBusinessRecord(
      'jev',
      record,
      { key: 'fake' },
      new AbortController().signal,
      fetcher,
    )
    expect(result).toMatchObject({
      label: 'inconsistent',
      confidence: 0.9,
      usage: { input: 500, output: 30 },
    })
    expect(JSON.parse(vi.mocked(fetcher).mock.calls[0]![1]!.body as string).state.record).toEqual(
      record,
    )
  })
  it('retains usage on invalid/truncated output and separates it from insufficient evidence', async () => {
    for (const payload of [
      { choices: [{ finish_reason: 'length', message: { content: '{"label":"consistent"}' } }] },
      { choices: [{ finish_reason: 'stop', message: { content: '{"label":"wrong"}' } }] },
    ]) {
      const result = await judgeBusinessRecord(
        'deepseek-flash',
        record,
        { key: 'fake' },
        new AbortController().signal,
        response({
          ...payload,
          usage: { prompt_tokens: 400, completion_tokens: 10, prompt_cache_hit_tokens: 0 },
        }),
      )
      expect(result.error).toBeTruthy()
      expect(result.label).toBeUndefined()
      expect(result.usage?.input).toBe(400)
    }
  })
  it('uses global endpoint configuration, never assigns fake confidence, and avoids costs for custom gateways', async () => {
    const fetcher = response({
      choices: [{ finish_reason: 'stop', message: { content: '{"label":"insufficient"}' } }],
      usage: { prompt_tokens: 400, completion_tokens: 10, prompt_cache_hit_tokens: 0 },
    })
    const result = await judgeBusinessRecord(
      'deepseek-flash',
      record,
      { key: 'fake', baseUrl: 'https://gateway.example/v1' },
      new AbortController().signal,
      fetcher,
    )
    expect(result).toMatchObject({ label: 'insufficient', usage: { costMin: null } })
    expect(result.confidence).toBeUndefined()
    expect(vi.mocked(fetcher).mock.calls[0]![0]).toBe('https://gateway.example/v1/chat/completions')
    expect(JSON.parse(vi.mocked(fetcher).mock.calls[0]![1]!.body as string).thinking).toEqual({
      type: 'disabled',
    })
  })
})
