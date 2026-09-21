import type { FollowEngine, FollowUsage } from '../shared/voice-follow'

type Json = Record<string, any>
const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0
const probability = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1

export function followUsage(
  engine: FollowEngine,
  usage: Json | undefined,
  official = true,
): FollowUsage | undefined {
  if (!usage) return undefined
  const input = engine === 'jev' ? usage.input_tokens : usage.prompt_tokens
  const output = engine === 'jev' ? usage.output_tokens : usage.completion_tokens
  if (!count(input) || !count(output)) return undefined
  if (engine === 'jev')
    return {
      input,
      output,
      cacheHit: null,
      costMin: (input * 0.042) / 1e6,
      costMax: (input * 0.042) / 1e6,
    }
  const hit = usage.prompt_cache_hit_tokens
  const cacheHit = count(hit) && hit <= input ? hit : null
  // Report a dated tariff range rather than guessing holidays or a gateway's markup.
  const rates = engine === 'deepseek-flash' ? [0.15, 0.003, 0.6] : [0.66, 0.022, 1.98]
  const costMin =
    official && cacheHit !== null
      ? ((input - cacheHit) * rates[0]! + cacheHit * rates[1]! + output * rates[2]!) / 1e6
      : null
  return { input, output, cacheHit, costMin, costMax: costMin === null ? null : costMin * 2 }
}

export function parseChoice(
  value: Json,
  options: string[],
): { choice: string; confidence: number; margin: number } {
  if (
    !value ||
    value.type !== 'choice' ||
    !options.includes(value.choice) ||
    !probability(value.confidence)
  )
    throw new Error('Jev 返回了无效选项。')
  const ps = value.probabilities
  if (
    !ps ||
    Object.keys(ps).length !== options.length ||
    options.some((key) => !probability(ps[key]))
  )
    throw new Error('Jev 概率分布无效。')
  const values = options.map((key) => ps[key] as number).sort((a, b) => b - a)
  if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.02 || ps[value.choice] < values[0]!)
    throw new Error('Jev 概率分布不一致。')
  return {
    choice: value.choice,
    confidence: value.confidence,
    margin: values[0]! - (values[1] ?? 0),
  }
}
