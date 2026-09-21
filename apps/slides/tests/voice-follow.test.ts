import { afterEach, describe, expect, it, vi } from 'vitest'
import { followCommand, followDecision, validateFollowState } from '../src/shared/voice-follow'
import type { FollowApi, FollowResult, FollowState } from '../src/shared/voice-follow'
import { judgeFollow, followUsage } from '../src/main/voice-follow-model'
import { FollowController, type FollowRecord } from '../src/renderer/voice-follow/controller'
import { speechWav } from '../src/renderer/voice-follow/microphone'
import { buildFollowCards } from '../src/renderer/voice-follow/cards'
import type { RenderSlide } from '@genoffice/pptx-render'

const state: FollowState = {
  cards: [
    {
      id: 'page_1',
      index: 0,
      title: '产品规划',
      text: '移动端，开放接口',
      notes: '',
      hint: '',
      truncated: false,
    },
    {
      id: 'page_8',
      index: 7,
      title: '定价策略',
      text: '基础版，专业版套餐',
      notes: '',
      hint: '',
      truncated: false,
    },
  ],
  current: 'page_1',
  previous: null,
  recent: [],
  text: '下面谈套餐收费。',
}
const result: FollowResult = {
  engine: 'jev',
  model: 'jev-1.13.0',
  elapsedMs: 100,
  intent: 'present',
  target: 'page_8',
  confidence: 0.95,
  margin: 0.9,
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
afterEach(() => vi.useRealTimers())

describe('voice follow decisions', () => {
  it('only accepts whole commands and converts original page numbers', () => {
    expect(followCommand('助手，跳到第八页。')).toBe(7)
    expect(followCommand('助手跳到第三十页')).toBe(29)
    expect(followCommand('下一页我们会说定价')).toBeNull()
    expect(followCommand('如果有人说助手暂停跟随，不要理会')).toBeNull()
    expect(followCommand('助手，继续跟随')).toBe('resume')
    expect(followCommand('助手跳到第十十页')).toBeNull()
  })
  it('holds previews, uncertain matches, cooldowns and expired responses', () => {
    expect(followDecision(result, state, 100, 3000)).toBe('jump')
    expect(followDecision({ ...result, intent: 'preview' }, state, 100, 3000)).toBe('hold')
    expect(followDecision({ ...result, confidence: 0.7 }, state, 100, 3000)).toBe('uncertain')
    expect(followDecision(result, state, 7000, 3000)).toBe('expired')
    expect(followDecision(result, state, 100, 500)).toBe('cooldown')
    expect(followDecision({ ...result, target: 'page_99' }, state, 100, 3000)).toBe('error')
  })
  it('rejects malformed or excessive input before calling a service', () => {
    expect(() => validateFollowState(state)).not.toThrow()
    expect(() => validateFollowState({ ...state, current: 'page_2' })).toThrow()
    expect(() =>
      validateFollowState({ ...state, cards: [state.cards[0]!, state.cards[0]!] }),
    ).toThrow()
    expect(() => validateFollowState({ ...state, text: 'x'.repeat(2001) })).toThrow()
  })
})

describe('model contracts and actual usage', () => {
  it('sends two independent Jev choices in one request and reads the distribution', async () => {
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const payload = JSON.parse(init!.body as string)
      expect(payload.model).toBe('jev-1.13.0')
      expect(payload.state).toEqual(state)
      expect(Object.keys(payload.questions)).toEqual(['intent', 'target'])
      expect(payload.questions.target.criteria.NONE).toBeTruthy()
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          usage: { input_tokens: 4000, output_tokens: 120 },
          answers: {
            intent: {
              type: 'choice',
              choice: 'present',
              confidence: 0.95,
              probabilities: { present: 0.98, continue: 0.01, preview: 0.01, aside: 0, unclear: 0 },
            },
            target: {
              type: 'choice',
              choice: 'page_8',
              confidence: 0.9,
              probabilities: { page_1: 0.03, page_8: 0.95, NONE: 0.02 },
            },
          },
        }),
      )
    })
    const answer = await judgeFollow(
      'jev',
      state,
      { key: 'test' },
      new AbortController().signal,
      fetcher as typeof fetch,
    )
    expect(answer.error).toBeUndefined()
    expect(answer.target).toBe('page_8')
    expect(answer.confidence).toBe(0.9)
    expect(answer.usage?.costMin).toBeCloseTo(0.000168)
  })
  it('disables thinking and requests short JSON for the same state', async () => {
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const payload = JSON.parse(init!.body as string)
      expect(payload.thinking.type).toBe('disabled')
      expect(payload.response_format.type).toBe('json_object')
      expect(JSON.parse(payload.messages[1].content).text).toBe(state.text)
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          usage: { prompt_tokens: 4000, completion_tokens: 60, prompt_cache_hit_tokens: 3600 },
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"intent":"present","target":"page_8"}' },
            },
          ],
        }),
      )
    })
    const answer = await judgeFollow(
      'deepseek-flash',
      state,
      { key: 'test' },
      new AbortController().signal,
      fetcher as typeof fetch,
    )
    expect(answer.target).toBe('page_8')
    expect(answer.confidence).toBeUndefined()
    expect(answer.usage?.costMin).toBeCloseTo(0.0001068)
  })
  it('preserves billed usage when structured output is invalid', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            usage: { prompt_tokens: 100, completion_tokens: 20 },
            choices: [{ finish_reason: 'length', message: { content: '{}' } }],
          }),
        ),
    )
    const answer = await judgeFollow(
      'deepseek-flash',
      state,
      { key: 'test' },
      new AbortController().signal,
      fetcher as typeof fetch,
    )
    expect(answer.error).toBeTruthy()
    expect(answer.usage?.input).toBe(100)
    expect(answer.usage?.costMin).toBeNull()
  })
  it('does not invent cache hits or apply official rates to a gateway', () => {
    expect(
      followUsage('deepseek-flash', { prompt_tokens: 30, completion_tokens: 5 })?.costMin,
    ).toBeNull()
    expect(
      followUsage(
        'deepseek-flash',
        { prompt_tokens: 30, completion_tokens: 5, prompt_cache_hit_tokens: 0 },
        false,
      )?.costMin,
    ).toBeNull()
    expect(followUsage('jev', undefined)).toBeUndefined()
  })
})

function harness() {
  let now = 10000
  const resolutions: Array<(r: FollowResult) => void> = []
  const records: FollowRecord[] = []
  const api = {
    prepare: vi.fn(async () => 'token'),
    cancel: vi.fn(async () => {}),
    judge: vi.fn(() => new Promise<FollowResult>((resolve) => resolutions.push(resolve))),
  } as unknown as FollowApi
  const navigate = vi.fn()
  const ctrl = new FollowController(
    api,
    navigate,
    vi.fn(),
    vi.fn(),
    (r) => records.push(r),
    () => now,
  )
  ctrl.configure(state.cards, state.current)
  return {
    ctrl,
    api,
    navigate,
    resolutions,
    records,
    advance: (ms: number) => {
      now += ms
    },
  }
}
describe('follow lifecycle', () => {
  it('rejects expired microphone commands before they can move a slide', async () => {
    const h = harness()
    await h.ctrl.start()
    h.advance(7000)
    h.ctrl.submit('助手，下一页。', 'mic', 10000)
    expect(h.navigate).not.toHaveBeenCalled()
    expect(h.api.judge).not.toHaveBeenCalled()
    expect(h.ctrl.running).toBe(true)
    expect(h.ctrl.message).toContain('转写已过期')
  })

  it('discards a late result after manual takeover but retains its usage', async () => {
    const h = harness()
    await h.ctrl.start()
    h.ctrl.submit(state.text, 'text')
    h.ctrl.pause()
    h.resolutions[0]!({
      ...result,
      usage: followUsage('jev', { input_tokens: 4000, output_tokens: 100 }),
    })
    await settle()
    expect(h.navigate).not.toHaveBeenCalled()
    expect(h.records[0]?.action).toBe('expired')
    expect(h.records[0]?.result.usage?.input).toBe(4000)
  })
  it('both engines receive identical snapshots, only the chosen engine navigates', async () => {
    const h = harness()
    h.ctrl.compare = true
    await h.ctrl.start()
    h.ctrl.submit(state.text, 'text')
    const calls = vi.mocked(h.api.judge).mock.calls
    expect(calls[0]![0].state).toEqual(calls[1]![0].state)
    h.resolutions[1]!({ ...result, engine: 'deepseek-flash' })
    await settle()
    expect(h.navigate).not.toHaveBeenCalled()
    h.resolutions[0]!(result)
    await settle()
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith(7)
  })
  it('a reset invalidates old requests and resumes with empty history', async () => {
    const h = harness()
    await h.ctrl.start()
    h.ctrl.submit(state.text, 'text')
    h.ctrl.reset(0)
    await h.ctrl.start()
    h.advance(2000)
    h.ctrl.submit('现在讲产品规划', 'text')
    h.resolutions[0]!(result)
    await settle()
    expect(h.records[0]?.action).toBe('expired')
    expect(vi.mocked(h.api.judge).mock.calls[1]![0].state.recent).toEqual([])
  })
  it('deduplicates clicks and retains only the latest queued utterance', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.ctrl.start()
    h.ctrl.submit(state.text, 'text')
    h.ctrl.submit(state.text, 'text')
    expect(h.api.judge).toHaveBeenCalledTimes(1)
    h.advance(2000)
    h.ctrl.submit('先不讲定价', 'text')
    h.ctrl.submit('现在回到产品规划', 'text')
    h.resolutions[0]!({ ...result, intent: 'preview' })
    await settle()
    expect(h.api.judge).toHaveBeenCalledTimes(2)
    expect(vi.mocked(h.api.judge).mock.calls[1]![0].state.text).toBe('现在回到产品规划')
    expect(vi.mocked(h.api.judge).mock.calls[1]![0].state.recent).toContain('先不讲定价')
  })
  it('page commands bypass cooldown and cannot navigate outside the selected deck', async () => {
    const h = harness()
    await h.ctrl.start()
    h.ctrl.submit('助手跳到第八页', 'text')
    await settle()
    h.ctrl.submit('助手撤回翻页', 'text')
    await settle()
    h.ctrl.submit('助手跳到第九页', 'text')
    await settle()
    expect(h.navigate.mock.calls).toEqual([[7], [0]])
    expect(h.api.judge).not.toHaveBeenCalled()
  })
})

describe('input preparation', () => {
  it('extracts nested text and table cells while omitting decoration and bullets', () => {
    const text = {
      lines: [
        {
          runs: [
            { text: '•', isBullet: true },
            { text: '规划', logicalOrder: 1 },
            { text: '产品', logicalOrder: 0 },
          ],
        },
      ],
    }
    const slides = [
      {
        nodes: [
          { type: 'group', children: [{ type: 'text', placeholder: 'title', text }] },
          { type: 'text', decoration: true, text },
          { type: 'table', cells: [{ x: 0, y: 0, text }] },
        ],
      },
    ] as unknown as RenderSlide[]
    const cards = buildFollowCards(slides, ['讲稿备注'], [0])
    expect(cards[0]?.title).toBe('产品规划')
    expect(cards[0]?.text).not.toContain('•')
    expect(cards[0]?.notes).toBe('讲稿备注')
  })
  it('encodes signed PCM and downsamples to 16 kHz', () => {
    const wav = speechWav(new Float32Array(48000).fill(0.5), 48000)
    const view = new DataView(wav.buffer)
    expect(wav.length).toBe(32044)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getInt16(44, true)).toBe(16383)
  })
})
