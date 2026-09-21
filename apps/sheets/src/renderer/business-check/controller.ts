import { applicability, checkRecordSchema, CHECK_VERSION } from '../../shared/business-check'
import type {
  BusinessCheckApi,
  CheckEngine,
  CheckRecord,
  CheckResult,
} from '../../shared/business-check'
import { columnLabel, parseRange, formatAddress } from '../../domain/cell-address'
import type { RangeBounds } from '../../domain/cell-address'

export interface CheckScope {
  workbookId: string
  sheetId: string
  sheetName: string
  range: string
}
export interface CheckConfig extends CheckScope {
  headerRow: number
  columns: { project: number; status: number; progress: number; feedback: number | null }
  engines: CheckEngine[]
}
export interface RowReport {
  record: CheckRecord
  applicability: ReturnType<typeof applicability>
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  stale: boolean
  results: CheckResult[]
}
export interface CheckAttempt {
  row: number
  record: CheckRecord
  result: CheckResult
  cancelled: boolean
}
export interface CheckReport {
  config: CheckConfig | null
  version: string
  busy: boolean
  phase: 'idle' | 'reading' | 'ready' | 'running' | 'completed' | 'cancelled' | 'failed'
  rows: RowReport[]
  empty: number
  structuralStale: boolean
  error: string
  attempts: CheckAttempt[]
  elapsedMs: number
}
export interface CheckDeps {
  currentWorkbook(): string | undefined
  aiBusy(): boolean
  load(sheetId: string, bounds: RangeBounds): Promise<boolean>
  read(sheetId: string, addresses: string[]): Record<string, { value: unknown }>
  navigate(sheetId: string, bounds: RangeBounds): Promise<unknown>
  api: BusinessCheckApi
}
const initial = (): CheckReport => ({
  config: null,
  version: CHECK_VERSION,
  busy: false,
  phase: 'idle',
  rows: [],
  empty: 0,
  structuralStale: false,
  error: '',
  attempts: [],
  elapsedMs: 0,
})
export function validateConfig(config: CheckConfig): RangeBounds {
  const bounds = parseRange(config.range.trim().toUpperCase())
  if (
    bounds.endRow > 1_048_575 ||
    bounds.endColumn > 16_383 ||
    bounds.endRow - bounds.startRow > 1000 ||
    bounds.endColumn - bounds.startColumn > 63 ||
    bounds.startRow === bounds.endRow
  )
    throw new Error('请选择含表头和数据的区域，预览版支持最多 1,000 条记录、64 列。')
  if (
    !Number.isInteger(config.headerRow) ||
    config.headerRow < bounds.startRow ||
    config.headerRow >= bounds.endRow
  )
    throw new Error('表头行必须在范围内，且后方包含数据。')
  const columns = Object.values(config.columns).filter((n): n is number => n !== null)
  if (
    columns.length < 3 ||
    new Set(columns).size !== columns.length ||
    columns.some((n) => !Number.isInteger(n) || n < bounds.startColumn || n > bounds.endColumn)
  )
    throw new Error('请选择范围内互不重复的项目、状态和依据列。')
  if (!config.engines.length || new Set(config.engines).size !== config.engines.length)
    throw new Error('请选择检查模型。')
  return bounds
}

export class BusinessCheckController {
  private report = initial()
  private listeners = new Set<() => void>()
  private epoch = 0
  private revision = 0
  private pending = new Set<string>()
  constructor(private deps: CheckDeps) {}
  snapshot = (): CheckReport => this.report
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private update(patch: Partial<CheckReport>): void {
    this.report = { ...this.report, ...patch }
    for (const listener of this.listeners) listener()
  }
  private assertCurrent(config: CheckScope): void {
    if (config.workbookId !== this.deps.currentWorkbook())
      throw new Error('工作簿已变化，请重新选择范围。')
  }
  async headers(scope: CheckScope, row: number): Promise<{ column: number; label: string }[]> {
    const bounds = parseRange(scope.range.toUpperCase())
    if (
      bounds.endColumn > 16_383 ||
      bounds.endRow > 1_048_575 ||
      bounds.endColumn - bounds.startColumn > 63 ||
      !Number.isInteger(row) ||
      row < bounds.startRow ||
      row > bounds.endRow
    )
      throw new Error('请填写有效范围和表头行。')
    this.assertCurrent(scope)
    if (!(await this.deps.load(scope.sheetId, { ...bounds, startRow: row, endRow: row })))
      throw new Error('读取表头失败。')
    this.assertCurrent(scope)
    const addresses = Array.from({ length: bounds.endColumn - bounds.startColumn + 1 }, (_, i) =>
      formatAddress(row, bounds.startColumn + i),
    )
    const cells = this.deps.read(scope.sheetId, addresses)
    return addresses.map((address, i) => ({
      column: bounds.startColumn + i,
      label: String(cells[address]?.value ?? columnLabel(bounds.startColumn + i)),
    }))
  }
  private async readRows(config: CheckConfig, onlyRow?: number): Promise<CheckRecord[]> {
    const bounds = validateConfig(config)
    const records: CheckRecord[] = []
    const start = onlyRow ?? config.headerRow + 1
    const end = onlyRow ?? bounds.endRow
    const epoch = this.epoch
    const revision = this.revision
    const columns = Object.values(config.columns).filter((n): n is number => n !== null)
    for (let row = start; row <= end; row += 100) {
      const last = Math.min(end, row + 99)
      this.assertCurrent(config)
      for (const column of columns) {
        if (
          !(await this.deps.load(config.sheetId, {
            startRow: row,
            endRow: last,
            startColumn: column,
            endColumn: column,
          }))
        )
          throw new Error('读取检查范围失败，请重试。')
      }
      this.assertCurrent(config)
      if (epoch !== this.epoch || revision !== this.revision)
        throw new Error('读取期间数据已变化或任务已停止，请重新读取。')
      const addresses: string[] = []
      for (let r = row; r <= last; r++)
        for (const column of columns) addresses.push(formatAddress(r, column))
      const cells = this.deps.read(config.sheetId, addresses)
      for (let r = row; r <= last; r++) {
        const value = (column: number | null) =>
          column === null ? '' : String(cells[formatAddress(r, column)]?.value ?? '')
        const record = {
          row: r,
          project: value(config.columns.project),
          status: value(config.columns.status),
          progress: value(config.columns.progress),
          feedback: value(config.columns.feedback),
        }
        if (!checkRecordSchema.safeParse(record).success)
          throw new Error(`第 ${r + 1} 行文字过长，单个字段最多 4,000 字；未截断或发送。`)
        records.push(record)
      }
    }
    return records
  }
  async prepare(config: CheckConfig): Promise<void> {
    if (this.report.busy || this.deps.aiBusy()) return
    const epoch = ++this.epoch
    this.update({ ...initial(), config: structuredClone(config), busy: true, phase: 'reading' })
    try {
      const records = await this.readRows(config)
      const rows: RowReport[] = records
        .filter((r) => applicability(r) !== 'empty')
        .map((record) => ({
          record,
          applicability: applicability(record),
          state: 'queued',
          stale: false,
          results: [],
        }))
      if (epoch !== this.epoch) return
      this.update({ rows, empty: records.length - rows.length, phase: 'ready' })
    } catch (error) {
      if (epoch === this.epoch) this.update({ error: String(error), phase: 'failed' })
    } finally {
      if (this.report.config?.workbookId === config.workbookId) this.update({ busy: false })
    }
  }
  stop(): void {
    this.epoch++
    for (const id of this.pending) void this.deps.api.cancel(id).catch(() => {})
    this.update({
      phase: 'cancelled',
      rows: this.report.rows.map((r) =>
        r.state === 'queued' || r.state === 'running' ? { ...r, state: 'cancelled' } : r,
      ),
    })
  }
  reset(): void {
    this.stop()
    this.update(initial())
  }
  changed(sheetId: string | undefined, bounds?: RangeBounds, structural = false): void {
    const config = this.report.config
    if (!config || (sheetId && sheetId !== config.sheetId)) return
    if (
      bounds &&
      !Object.values(config.columns).some(
        (c) => c !== null && c >= bounds.startColumn && c <= bounds.endColumn,
      )
    )
      return
    this.revision++
    if (bounds && bounds.startRow <= config.headerRow && bounds.endRow >= config.headerRow)
      structural = true
    if (structural) {
      if (this.report.busy) this.stop()
      this.update({ structuralStale: true })
    }
    this.update({
      rows: this.report.rows.map((row) =>
        structural ||
        !bounds ||
        (row.record.row >= bounds.startRow && row.record.row <= bounds.endRow)
          ? { ...row, stale: true }
          : row,
      ),
    })
  }
  async run(onlyRow?: number): Promise<void> {
    const config = this.report.config
    if (!config || this.report.busy || this.report.structuralStale || this.deps.aiBusy()) return
    if (onlyRow === undefined && this.report.rows.some((r) => r.stale)) {
      this.update({ error: '数据已变化，请重新读取范围，或复查变化行。' })
      return
    }
    const epoch = ++this.epoch
    const started = performance.now()
    this.update({ busy: true, error: '', phase: 'running' })
    try {
      this.assertCurrent(config)
      if (onlyRow !== undefined) {
        const record = (await this.readRows(config, onlyRow))[0]!
        this.update({
          rows: this.report.rows.map((r) =>
            r.record.row === onlyRow
              ? {
                  record,
                  applicability: applicability(record),
                  state: 'queued',
                  stale: false,
                  results: [],
                }
              : r,
          ),
        })
      }
      const rows = this.report.rows.filter((r) => onlyRow === undefined || r.record.row === onlyRow)
      for (const row of rows) {
        if (epoch !== this.epoch) break
        if (row.applicability !== 'eligible') {
          this.setRow(row.record.row, { state: 'completed' })
          continue
        }
        this.setRow(row.record.row, { state: 'running', results: [] })
        const results = await Promise.all(
          config.engines.map(async (engine) => {
            const id = crypto.randomUUID()
            this.pending.add(id)
            const requestStarted = performance.now()
            let result: CheckResult
            try {
              result = await this.deps.api.judge({ id, engine, record: row.record })
            } catch {
              result = {
                engine,
                model: engine,
                elapsedMs: Math.round(performance.now() - requestStarted),
                error: '请求失败，请检查全局设置后复查。',
              }
            } finally {
              this.pending.delete(id)
            }
            // Retain billed usage even when the report is cancelled or the row is stale.
            if (this.report.config === config)
              this.update({
                attempts: [
                  ...this.report.attempts,
                  {
                    row: row.record.row,
                    record: row.record,
                    result,
                    cancelled: epoch !== this.epoch,
                  },
                ],
              })
            return result
          }),
        )
        if (epoch !== this.epoch) break
        this.assertCurrent(config)
        this.setRow(row.record.row, {
          results,
          state: results.some((r) => r.error) ? 'failed' : 'completed',
        })
      }
      if (epoch === this.epoch) this.update({ phase: 'completed' })
    } catch (error) {
      if (epoch === this.epoch) this.update({ error: String(error), phase: 'failed' })
    } finally {
      if (this.report.config === config)
        this.update({ busy: false, elapsedMs: Math.round(performance.now() - started) })
    }
  }
  private setRow(row: number, patch: Partial<RowReport>): void {
    this.update({
      rows: this.report.rows.map((r) => (r.record.row === row ? { ...r, ...patch } : r)),
    })
  }
  async locate(row: number): Promise<void> {
    const config = this.report.config
    if (!config || this.report.structuralStale) return
    this.assertCurrent(config)
    const bounds = parseRange(config.range)
    await this.deps.navigate(config.sheetId, { ...bounds, startRow: row, endRow: row })
  }
}
