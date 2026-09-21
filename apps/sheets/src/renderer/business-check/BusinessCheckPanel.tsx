import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BusinessCheckController, CheckScope, CheckConfig, RowReport } from './controller'
import type { CheckEngine } from '../../shared/business-check'
import { CHECK_RULE } from '../../shared/business-check'
import { columnLabel, parseRange } from '../../domain/cell-address'
import { useI18n } from '../i18n/locale'
import './business-check.css'

export function BusinessCheckPanel({
  controller,
  scope,
  aiBusy,
}: {
  controller: BusinessCheckController
  scope: CheckScope | null
  aiBusy: boolean
}) {
  const { lang } = useI18n()
  const zh = lang.startsWith('zh')
  const l = (cn: string, en: string) => (zh ? cn : en)
  const report = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const [range, setRange] = useState(scope?.range ?? '')
  const [header, setHeader] = useState('1')
  const [columns, setColumns] = useState<CheckConfig['columns']>({
    project: 0,
    status: 1,
    progress: 2,
    feedback: null,
  })
  const [headers, setHeaders] = useState<{ column: number; label: string }[]>([])
  const [mode, setMode] = useState('jev')
  const [error, setError] = useState('')
  const [readingHeaders, setReadingHeaders] = useState(false)
  const [settings, setSettings] = useState({ jevReady: false, deepseekReady: false })
  const [all, setAll] = useState(false)
  const [configure, setConfigure] = useState(true)
  useEffect(() => {
    if (scope) {
      setRange(scope.range)
      setHeader(String(scope.range ? parseRange(scope.range).startRow + 1 : 1))
      setHeaders([])
      setConfigure(true)
    }
  }, [scope])
  useEffect(() => {
    const refresh = () => {
      void window.desktopApi.businessCheck
        .settings()
        .then(setSettings)
        .catch(() => setSettings({ jevReady: false, deepseekReady: false }))
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  const engines: CheckEngine[] =
    mode === 'compare' ? ['jev', 'deepseek-flash'] : [mode as CheckEngine]
  const ready = engines.every((e) => (e === 'jev' ? settings.jevReady : settings.deepseekReady))
  const busy = report.busy || aiBusy || readingHeaders
  async function readHeaders() {
    if (!scope) return
    setReadingHeaders(true)
    setError('')
    try {
      const values = await controller.headers({ ...scope, range }, Number(header) - 1)
      setHeaders(values)
      const guess = (names: string[], fallback: number | null) =>
        values.find((v) => names.includes(v.label.trim()))?.column ?? fallback
      setColumns({
        project: guess(['项目', '项目名称', '项目标识', '项目编号'], values[0]?.column ?? 0)!,
        status: guess(['状态', '项目状态', '交付状态'], values[1]?.column ?? 1)!,
        progress: guess(['最新进展', '进展', '备注'], values[2]?.column ?? 2)!,
        feedback: guess(['客户反馈', '反馈'], null),
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setReadingHeaders(false)
    }
  }
  const config: CheckConfig | null = scope
    ? {
        ...scope,
        range: range.toUpperCase().trim(),
        headerRow: Number(header) - 1,
        columns,
        engines,
      }
    : null
  const matches = config && JSON.stringify(config) === JSON.stringify(report.config)
  const eligible = report.rows.filter((r) => r.applicability === 'eligible')
  const returned = eligible.filter((r) => r.state === 'completed' || r.state === 'failed').length
  const label = (s: string) =>
    ({
      consistent: l('一致', 'Consistent'),
      inconsistent: l('不一致', 'Inconsistent'),
      insufficient: l('依据不足', 'Insufficient evidence'),
      'not-applicable': l('不适用', 'Not applicable'),
      missing: l('输入待补充', 'Missing input'),
      empty: l('空行', 'Empty'),
      queued: l('待检查', 'Queued'),
      running: l('检查中', 'Running'),
      completed: l('检查完成', 'Check completed'),
      cancelled: l('已停止', 'Stopped'),
      failed: l('失败', 'Failed'),
      idle: l('尚未读取', 'Not loaded'),
      reading: l('正在读取范围', 'Reading range'),
      ready: l('已读取，待开始', 'Ready'),
    })[s] ?? s
  const needsReview = (row: RowReport) =>
    row.stale ||
    row.state === 'failed' ||
    row.applicability === 'missing' ||
    row.results.some(
      (r) => r.label !== 'consistent' || (r.confidence !== undefined && r.confidence < 0.8),
    ) ||
    new Set(row.results.map((r) => r.label)).size > 1
  const shown = all ? report.rows : report.rows.filter(needsReview)
  function exportReport() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            ...report,
            pricingDate: '2026-09-21',
            batchSize: 1,
            concurrencyPerEngine: 1,
            retries: 0,
            thinking: 'disabled',
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'business-check-report.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <section
      className="business-check"
      aria-label={l('业务一致性校验', 'Business consistency check')}
    >
      <h3>{l('项目交付状态一致性（预览版）', 'Delivery consistency (Preview)')}</h3>
      <p className="bc-muted">
        {zh
          ? CHECK_RULE
          : 'Only explicit customer acceptance of this project’s current delivery supports 已完成. Internal tests, delivery, plans and receipt of materials do not count.'}
      </p>
      <details open={configure} onToggle={(e) => setConfigure(e.currentTarget.open)}>
        <summary>{l('检查范围与字段', 'Scope and fields')}</summary>
        <fieldset disabled={busy}>
          <legend className="bc-sr-only">{l('检查范围与字段', 'Scope and fields')}</legend>
          <p>{scope?.sheetName ?? l('请先打开工作表', 'Open a worksheet first')}</p>
          <label>
            {l('范围（包含表头）', 'Range (including header)')}
            <input
              aria-label={l('检查范围', 'Check range')}
              placeholder="A1:D25"
              value={range}
              onChange={(e) => {
                setRange(e.target.value)
                setHeaders([])
              }}
            />
          </label>
          {!range && (
            <p className="bc-muted">
              {l(
                '请框选多单元格范围，或输入精确范围；不会自动扫描整张表。',
                'Select multiple cells or enter an exact range.',
              )}
            </p>
          )}
          <label>
            {l('表头行', 'Header row')}
            <input
              type="number"
              min="1"
              value={header}
              onChange={(e) => {
                setHeader(e.target.value)
                setHeaders([])
              }}
            />
          </label>
          <button disabled={!scope || !range} onClick={() => void readHeaders()}>
            {l('读取表头', 'Read headers')}
          </button>
          {headers.length > 0 && (
            <>
              {(['project', 'status', 'progress', 'feedback'] as const).map((key) => (
                <label key={key}>
                  {
                    {
                      project: l('项目标识', 'Project'),
                      status: l('状态', 'Status'),
                      progress: l('最新进展', 'Progress'),
                      feedback: l('客户反馈（可选）', 'Feedback (optional)'),
                    }[key]
                  }
                  <select
                    value={columns[key] ?? ''}
                    onChange={(e) =>
                      setColumns({
                        ...columns,
                        [key]: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                  >
                    {key === 'feedback' && <option value="">{l('不使用', 'None')}</option>}
                    {headers.map((h) => (
                      <option key={h.column} value={h.column}>
                        {columnLabel(h.column)} · {h.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label>
                {l('检查方式', 'Method')}
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="jev">Jev</option>
                  <option value="deepseek-flash">DeepSeek Flash</option>
                  <option value="compare">{l('对比两个模型', 'Compare both models')}</option>
                </select>
              </label>
              <button
                onClick={async () => {
                  if (config) {
                    await controller.prepare(config)
                    if (controller.snapshot().phase === 'ready') setConfigure(false)
                  }
                }}
              >
                {l('读取检查范围', 'Read check range')}
              </button>
            </>
          )}
        </fieldset>
      </details>
      <p className="bc-muted">
        {l(
          '包含范围内隐藏与筛选隐藏的行。只生成报告，不修改表格。',
          'Includes hidden and filtered rows. Creates a report without editing cells.',
        )}
      </p>
      <p className="bc-muted">
        Jev {settings.jevReady ? '✓' : '—'} · DeepSeek {settings.deepseekReady ? '✓' : '—'} ·{' '}
        {l('配置统一位于 Settings → AI 模型', 'Configure in Settings → AI models')}
      </p>
      {aiBusy && (
        <p role="status">
          {l('请等待当前 AI 对话完成。', 'Wait for the current AI task to finish.')}
        </p>
      )}
      {(error || report.error) && <p role="alert">{error || report.error}</p>}
      {report.config && (
        <>
          <div className="bc-summary" role="status" aria-live="polite">
            <strong>
              {report.config.sheetName} · {report.config.range}
            </strong>
            <p>
              {label(report.phase)} · {l('记录', 'Rows')} {report.rows.length} ·{' '}
              {l('适用', 'Eligible')} {eligible.length} · {l('已返回', 'Returned')} {returned}/
              {eligible.length}
            </p>
            <p>
              {l('空行', 'Empty')} {report.empty} · {l('不适用', 'Not applicable')}{' '}
              {report.rows.filter((r) => r.applicability === 'not-applicable').length} ·{' '}
              {l('输入待补充', 'Missing input')}{' '}
              {report.rows.filter((r) => r.applicability === 'missing').length}
            </p>
            <p>
              {l('已变化', 'Changed')} {report.rows.filter((r) => r.stale).length} ·{' '}
              {l('失败', 'Failed')} {report.rows.filter((r) => r.state === 'failed').length}
            </p>
          </div>
          {report.attempts.length > 0 && (
            <div className="bc-summary">
              {report.config.engines.map((engine) => {
                const results = report.rows
                  .filter((row) => !row.stale && !report.structuralStale)
                  .flatMap((row) => row.results.filter((result) => result.engine === engine))
                return (
                  <p key={engine}>
                    <strong>{engine === 'jev' ? 'Jev' : 'DeepSeek'}</strong> ·{' '}
                    {(['inconsistent', 'insufficient', 'consistent'] as const)
                      .map(
                        (value) =>
                          `${label(value)} ${results.filter((result) => result.label === value).length}`,
                      )
                      .join(' · ')}{' '}
                    · {l('待复核', 'Review')}{' '}
                    {
                      results.filter(
                        (result) => result.confidence !== undefined && result.confidence < 0.8,
                      ).length
                    }
                  </p>
                )
              })}
              <p>
                {l('当前有效记录的模型分歧', 'Disagreements on current rows')}{' '}
                {
                  report.rows.filter(
                    (row) =>
                      !row.stale &&
                      !report.structuralStale &&
                      new Set(row.results.flatMap((result) => (result.label ? [result.label] : [])))
                        .size > 1,
                  ).length
                }
              </p>
            </div>
          )}
          {report.structuralStale && (
            <p role="alert">
              {l(
                '表格结构已变化，请重新读取范围；旧结果不能再定位。',
                'Sheet structure changed. Reload the range; old navigation is disabled.',
              )}
            </p>
          )}
          {!matches && (
            <p className="bc-muted">
              {l(
                '配置已变化，请重新读取检查范围。',
                'Configuration changed. Read the range again.',
              )}
            </p>
          )}
          <div className="bc-actions">
            <button
              disabled={
                busy ||
                !matches ||
                (!ready && eligible.length > 0) ||
                report.structuralStale ||
                report.rows.some((r) => r.stale) ||
                report.phase !== 'ready'
              }
              onClick={() => void controller.run()}
            >
              {l('开始检查', 'Start check')}
            </button>
            <button disabled={!report.busy} onClick={() => controller.stop()}>
              {l('停止', 'Stop')}
            </button>
            <button disabled={report.busy || !report.rows.length} onClick={exportReport}>
              {l('导出报告', 'Export report')}
            </button>
          </div>
          {report.attempts.length > 0 && (
            <details className="bc-metrics">
              <summary>{l('耗时、token 与费用', 'Timing, tokens and cost')}</summary>
              <strong>
                {l(
                  '本次任务累计用量（含复查与失败）',
                  'Cumulative usage (including rechecks and failures)',
                )}
              </strong>
              {report.config.engines.map((engine) => {
                const attempts = report.attempts.filter((a) => a.result.engine === engine)
                const usages = attempts.flatMap((a) => (a.result.usage ? [a.result.usage] : []))
                const costsKnown =
                  attempts.length > 0 &&
                  usages.length === attempts.length &&
                  usages.every((u) => u.costMin !== null)
                return (
                  <p key={engine}>
                    {[...new Set(attempts.map((a) => a.result.model))].join(', ') || engine}
                    <br />
                    {attempts.length} {l('次请求', 'requests')} ·{' '}
                    {attempts.reduce((n, a) => n + a.result.elapsedMs, 0)} ms ·{' '}
                    {usages.reduce((n, u) => n + u.input, 0)} in /{' '}
                    {usages.reduce((n, u) => n + u.output, 0)} out tokens
                    <br />
                    {costsKnown
                      ? `$${usages.reduce((n, u) => n + u.costMin!, 0).toFixed(6)}–$${usages.reduce((n, u) => n + u.costMax!, 0).toFixed(6)}`
                      : l('费用未知或不完整', 'Cost unknown or incomplete')}{' '}
                    · {l('用量未返回', 'Missing usage')} {attempts.length - usages.length} ·{' '}
                    {l('有效输出', 'Valid output')} {attempts.filter((a) => a.result.label).length}/
                    {attempts.length}
                  </p>
                )
              })}
              <p className="bc-muted">
                {l('最近执行耗时', 'Last execution')} {report.elapsedMs} ms.{' '}
                {l(
                  '每模型逐行串行；对比模型并行；不自动重试。DeepSeek 关闭思考。单价：2026-09-21；费用为官方峰谷区间，未知用量不计为零。停止可能仍计费。无人工标注，不显示准确率。',
                  'Serial rows per model; models run concurrently; no retries. DeepSeek thinking off. Tariffs: 2026-09-21. Official peak/off-peak estimate; missing usage is unknown. Cancellation may still incur charges. No accuracy without labels.',
                )}
              </p>
            </details>
          )}
          <button aria-pressed={all} onClick={() => setAll(!all)}>
            {all
              ? l('只看问题与待复核', 'Show issues and review items')
              : l('查看全部记录', 'Show all rows')}{' '}
            ({shown.length})
          </button>
          {shown.map((row) => (
            <article className="bc-row" key={row.record.row}>
              <strong>
                {row.record.project || l('未命名项目', 'Unnamed project')} · {l('第', 'Row')}{' '}
                {row.record.row + 1} {zh ? '行' : ''}
              </strong>
              <p>
                {row.stale ? l('数据已变化 · ', 'Data changed · ') : ''}
                {row.applicability !== 'eligible' ? label(row.applicability) : label(row.state)}
              </p>
              {row.results.map((result) => (
                <div className="bc-result" key={result.engine}>
                  <strong>
                    {result.model} · {result.label ? label(result.label) : l('失败', 'Failed')}
                  </strong>
                  <p>
                    {result.error ??
                      (result.label === 'consistent'
                        ? l(
                            '记录提供了明确的客户验收通过依据。',
                            'Evidence states customer acceptance passed.',
                          )
                        : result.label === 'inconsistent'
                          ? l(
                              '记录表明本次客户验收尚未通过或尚未完成。',
                              'Evidence says acceptance has not passed or is pending.',
                            )
                          : l(
                              '记录缺少明确验收依据，或存在未消解的冲突。',
                              'Acceptance evidence is missing, unclear or conflicting.',
                            ))}
                  </p>
                  {result.confidence !== undefined && (
                    <small>
                      {l('置信度', 'Confidence')} {result.confidence.toFixed(2)}{' '}
                      {result.confidence < 0.8 ? l('· 待复核', '· Review required') : ''}
                    </small>
                  )}
                </div>
              ))}
              {new Set(row.results.flatMap((r) => (r.label ? [r.label] : []))).size > 1 && (
                <p>{l('模型分歧：请结合原文复核。', 'Models disagree: review the evidence.')}</p>
              )}
              <details>
                <summary>{l('完整依据原文', 'Full source evidence')}</summary>
                <p>
                  {l('状态', 'Status')}: {row.record.status || '—'}
                </p>
                <p>
                  {l('最新进展', 'Progress')}: {row.record.progress || '—'}
                </p>
                <p>
                  {l('客户反馈', 'Feedback')}: {row.record.feedback || '—'}
                </p>
              </details>
              <div className="bc-actions">
                <button
                  disabled={report.structuralStale}
                  onClick={() =>
                    void controller.locate(row.record.row).catch((e) => setError(String(e)))
                  }
                >
                  {l('定位到本行', 'Locate row')}
                </button>
                <button
                  disabled={
                    busy ||
                    report.structuralStale ||
                    !report.config?.engines.every((e) =>
                      e === 'jev' ? settings.jevReady : settings.deepseekReady,
                    )
                  }
                  onClick={() => void controller.run(row.record.row)}
                >
                  {l('复查本行', 'Recheck row')}
                </button>
              </div>
            </article>
          ))}
          <p className="bc-muted">
            {l(
              'Jev 置信度不是准确率；0.8 待复核阈值尚未校准。结论仅核对记录中的文字依据。',
              'Jev confidence is not accuracy. The 0.8 review threshold is uncalibrated. Judgments assess recorded evidence only.',
            )}
          </p>
        </>
      )}
    </section>
  )
}
