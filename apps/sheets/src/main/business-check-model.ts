import {
  CHECK_CRITERIA,
  CHECK_INSTRUCTION,
  CHECK_RULE,
  checkRecordSchema,
  applicability,
} from '../shared/business-check'
import type { CheckEngine, CheckRecord, CheckResult, CheckLabel } from '../shared/business-check'
import { followUsage, parseChoice } from '../../../slides/src/main/semantic-model-utils'

export async function judgeBusinessRecord(
  engine: CheckEngine,
  record: CheckRecord,
  config: { key: string; baseUrl?: string },
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CheckResult> {
  const started = performance.now()
  const result: CheckResult = {
    engine,
    model: engine === 'jev' ? 'jev-1.13.0' : engine,
    elapsedMs: 0,
  }
  try {
    checkRecordSchema.parse(record)
    if (applicability(record) !== 'eligible') throw new Error('该记录不适用本规则。')
    if (!config.key) throw new Error('请在全局 Settings → AI 模型中配置密钥。')
    const state = { rule: CHECK_RULE, record }
    const question = { type: 'choice', instructions: CHECK_INSTRUCTION, criteria: CHECK_CRITERIA }
    const base = (config.baseUrl || 'https://api.deepseek.com/v1').replace(/\/$/, '')
    const response = await fetcher(
      engine === 'jev' ? 'https://api.typesafe.ai/v1/systemone' : `${base}/chat/completions`,
      {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          engine === 'jev'
            ? { model: result.model, state, questions: { acceptance: question } }
            : {
                model: engine,
                thinking: { type: 'disabled' },
                response_format: { type: 'json_object' },
                max_tokens: 80,
                messages: [
                  {
                    role: 'system',
                    content: `Return only json {"label":"consistent|inconsistent|insufficient"}. Evaluate this question: ${JSON.stringify(question)}`,
                  },
                  { role: 'user', content: JSON.stringify(state) },
                ],
              },
        ),
      },
    )
    if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}。`)
    const data = await response.json()
    const usage = followUsage(engine, data.usage, new URL(base).hostname === 'api.deepseek.com')
    if (usage) result.usage = usage
    if (typeof data.model === 'string') result.model = data.model
    if (engine === 'jev') {
      const answer = parseChoice(data.answers?.acceptance, Object.keys(CHECK_CRITERIA))
      result.label = answer.choice as CheckLabel
      result.confidence = answer.confidence
    } else {
      if (data.choices?.[0]?.finish_reason !== 'stop') throw new Error('模型输出未完整结束。')
      const label = JSON.parse(data.choices[0].message.content)?.label
      if (typeof label !== 'string' || !Object.hasOwn(CHECK_CRITERIA, label))
        throw new Error('模型返回无效分类。')
      result.label = label as CheckLabel
    }
  } catch (error) {
    result.error = signal.aborted
      ? '请求已取消或超时，服务端可能仍产生费用。'
      : error instanceof Error
        ? error.message
        : '请求失败。'
  }
  result.elapsedMs = Math.round(performance.now() - started)
  return result
}
