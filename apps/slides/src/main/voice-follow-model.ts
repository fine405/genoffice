import {
  FOLLOW_INTENTS,
  FOLLOW_INTENT_QUESTION,
  FOLLOW_TARGET_QUESTION,
  validateFollowState,
} from '../shared/voice-follow'
import type { FollowEngine, FollowIntent, FollowResult, FollowState } from '../shared/voice-follow'

import { followUsage, parseChoice } from './semantic-model-utils'
export { followUsage } from './semantic-model-utils'
type Json = Record<string, any>

export async function judgeFollow(
  engine: FollowEngine,
  state: FollowState,
  config: { key: string; baseUrl?: string },
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<FollowResult> {
  const started = performance.now()
  const result: FollowResult = {
    engine,
    model: engine === 'jev' ? 'jev-1.13.0' : engine,
    elapsedMs: 0,
  }
  try {
    validateFollowState(state)
    if (!config.key) throw new Error(`请先配置 ${engine === 'jev' ? 'Jev' : 'DeepSeek'} API Key。`)
    const criteria = Object.fromEntries([
      ...state.cards.map((c) => [c.id, c.title]),
      ['NONE', 'No unique matching slide'],
    ])
    const questions = {
      intent: { type: 'choice', instructions: FOLLOW_INTENT_QUESTION, criteria: FOLLOW_INTENTS },
      target: { type: 'choice', instructions: FOLLOW_TARGET_QUESTION, criteria },
    }
    const base = (config.baseUrl || 'https://api.deepseek.com/v1').replace(/\/$/, '')
    const url =
      engine === 'jev' ? 'https://api.typesafe.ai/v1/systemone' : `${base}/chat/completions`
    const body =
      engine === 'jev'
        ? { model: result.model, state, questions }
        : {
            model: engine,
            thinking: { type: 'disabled' },
            response_format: { type: 'json_object' },
            max_tokens: 160,
            messages: [
              {
                role: 'system',
                content: `Answer these two independent questions using the supplied presentation state. Return only json: {"intent":"present|continue|preview|aside|unclear","target":"page_N|NONE"}. Rules: ${JSON.stringify(questions)}. Cards: ${JSON.stringify(state.cards)}`,
              },
              {
                role: 'user',
                content: JSON.stringify({
                  current: state.current,
                  previous: state.previous,
                  recent: state.recent,
                  text: state.text,
                }),
              },
            ],
          }
    const response = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok)
      throw new Error(`模型服务返回 HTTP ${response.status}，请检查配置或稍后重试。`)
    const data: Json = await response.json()
    result.usage = followUsage(engine, data.usage, new URL(base).hostname === 'api.deepseek.com')
    if (typeof data.model === 'string') result.model = data.model
    if (engine === 'jev') {
      const intent = parseChoice(data.answers?.intent, Object.keys(FOLLOW_INTENTS))
      const target = parseChoice(data.answers?.target, Object.keys(criteria))
      result.intent = intent.choice as FollowIntent
      result.target = target.choice
      result.confidence = Math.min(intent.confidence, target.confidence)
      result.margin = target.margin
    } else {
      const choice = data.choices?.[0]
      if (choice?.finish_reason !== 'stop') throw new Error('模型输出未完整结束。')
      const parsed = JSON.parse(choice.message.content)
      if (!Object.hasOwn(FOLLOW_INTENTS, parsed.intent) || !Object.hasOwn(criteria, parsed.target))
        throw new Error('模型返回了无效意图或页码。')
      result.intent = parsed.intent
      result.target = parsed.target
    }
  } catch (error) {
    result.error = signal.aborted
      ? '请求已取消或超时。'
      : error instanceof Error
        ? error.message
        : '模型请求失败。'
  }
  result.elapsedMs = Math.round(performance.now() - started)
  return result
}
