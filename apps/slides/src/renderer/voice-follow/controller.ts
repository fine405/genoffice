import { followCommand, followDecision, validateFollowState } from '../../shared/voice-follow'
import type {
  FollowApi,
  FollowCard,
  FollowEngine,
  FollowResult,
  FollowState,
} from '../../shared/voice-follow'

export interface FollowRecord {
  id: string
  source: 'text' | 'mic'
  text: string
  state: FollowState
  result: FollowResult
  action: string
  elapsedMs: number
  at: string
}
interface Input {
  text: string
  source: 'text' | 'mic'
  at: number
}

/** Owns ordering and freshness independently of React or the model adapter. */
export class FollowController {
  running = false
  busy = false
  message = '选择输入方式后开始跟随。'
  engine: FollowEngine = 'jev'
  compare = false
  cards: FollowCard[] = []
  current = ''
  previous: string | null = null
  private epoch = 0
  private token = ''
  private pending: Input | null = null
  private recent: Input[] = []
  private lastJump = -Infinity
  private lastSend = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  private starting = false
  private submitted: Input | null = null
  constructor(
    private api: FollowApi,
    private navigate: (index: number) => void,
    private exit: () => void,
    private changed: () => void,
    private record: (record: FollowRecord) => void,
    private now: () => number = () => performance.now(),
  ) {}

  configure(cards: FollowCard[], current: string): void {
    if (JSON.stringify(cards) !== JSON.stringify(this.cards)) {
      this.pause('页面内容已更新，请重新开始跟随。')
      this.cards = cards
      this.recent = []
      this.previous = null
    }
    if (this.current && current !== this.current) this.pause('已手动切页，跟随暂停。')
    this.current = current
  }
  pause(message = '跟随已暂停。'): void {
    this.epoch++
    this.running = false
    this.busy = false
    this.starting = false
    this.pending = null
    this.token = ''
    clearTimeout(this.timer)
    void this.api.cancel().catch(() => {})
    this.message = message
    this.changed()
  }
  async start(): Promise<void> {
    if (this.running || this.starting) return
    const epoch = ++this.epoch
    this.starting = true
    this.message = '正在准备页面…'
    this.changed()
    try {
      validateFollowState(this.state('prepare'))
      const token = await this.api.prepare(this.cards)
      if (epoch !== this.epoch) return
      this.token = token
      this.recent = []
      this.running = true
      this.message = '正在跟随，等待新的讲述。'
    } catch (e) {
      if (epoch === this.epoch) this.message = e instanceof Error ? e.message : '准备失败。'
    } finally {
      if (epoch === this.epoch) {
        this.starting = false
        this.changed()
      }
    }
  }
  reset(index: number): void {
    this.pause('已重新演示，请开始跟随。')
    this.recent = []
    this.previous = null
    this.lastJump = -Infinity
    this.lastSend = -Infinity
    this.current = this.cards.find((c) => c.index === index)?.id ?? this.cards[0]?.id ?? ''
    this.navigate(index)
    this.changed()
  }
  private jump(index: number): void {
    const card = this.cards.find((c) => c.index === index)
    if (!card) {
      this.message = '该页不在当前放映范围内。'
      this.changed()
      return
    }
    if (card.id === this.current) return
    this.previous = this.current
    this.current = card.id
    this.lastJump = this.now()
    this.navigate(index)
  }
  private state(text: string): FollowState {
    return {
      cards: this.cards,
      current: this.current,
      previous: this.previous,
      recent: this.recent
        .filter((i) => this.now() - i.at < 20000)
        .slice(-2)
        .map((i) => i.text),
      text,
    }
  }
  submit(text: string, source: 'text' | 'mic', at = this.now()): void {
    text = text.trim()
    if (!text || text.length > 2000) return
    if (source === 'mic' && this.now() - at > 6000) {
      this.message = '转写已过期，保持当前页，请继续讲述。'
      this.changed()
      return
    }
    const command = followCommand(text)
    if (command !== null) {
      if (command === 'pause') this.pause()
      else if (command === 'resume') void this.start()
      else if (command === 'exit') {
        this.pause()
        this.exit()
      } else {
        const wasRunning = this.running
        this.pause('已执行翻页口令。')
        const pos = this.cards.findIndex((c) => c.id === this.current)
        const index =
          typeof command === 'number'
            ? command
            : command === 'undo'
              ? this.cards.find((c) => c.id === this.previous)?.index
              : this.cards[pos + (command === 'next' ? 1 : -1)]?.index
        if (index !== undefined) this.jump(index)
        else this.message = '没有可切换的页面。'
        if (wasRunning) void this.start()
      }
      this.changed()
      return
    }
    if (!this.running) {
      this.message = '请先开始或继续跟随。'
      this.changed()
      return
    }
    if (this.submitted?.text === text && this.now() - this.submitted.at < 500) return
    this.submitted = { text, source, at: this.now() }
    if (this.pending) {
      this.recent.push(this.pending)
      this.recent = this.recent.slice(-2)
      this.message = '连续输入已合并，将判断最新讲述。'
    }
    this.pending = { text, source, at }
    this.changed()
    this.drain()
  }
  private drain(): void {
    if (!this.running || this.busy || !this.pending) return
    const wait = 1500 - (this.now() - this.lastSend)
    if (wait > 0) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.drain(), wait)
      return
    }
    const input = this.pending
    this.pending = null
    const state = this.state(input.text)
    const epoch = this.epoch
    const token = this.token
    this.lastSend = this.now()
    this.recent.push(input)
    this.recent = this.recent.slice(-2)
    this.busy = true
    this.message = '正在判断…'
    this.changed()
    const engines: FollowEngine[] = this.compare
      ? [this.engine, this.engine === 'jev' ? 'deepseek-flash' : 'jev']
      : [this.engine]
    void Promise.all(
      engines.map(async (engine) => {
        const id = crypto.randomUUID()
        let result: FollowResult
        try {
          result = await this.api.judge({ token, id, engine, state })
        } catch (e) {
          result = {
            engine,
            model: engine,
            elapsedMs: this.now() - this.lastSend,
            error: e instanceof Error ? e.message : '判断失败。',
          }
        }
        const stale = epoch !== this.epoch || !this.running
        let action = stale
          ? 'expired'
          : followDecision(result, state, this.now() - input.at, this.now() - this.lastJump)
        if (!stale && engine === engines[0]) {
          if (action === 'jump') this.jump(state.cards.find((c) => c.id === result.target)!.index)
          this.message =
            result.error ||
            ({
              jump: '已翻页',
              hold: '保持当前页',
              current: '正在讲述当前页',
              uncertain: '匹配不确定，等待补充',
              cooldown: '刚刚翻页，等待下一句',
              expired: '判断已过期，保持当前页',
            }[action] ??
              '保持当前页')
        } else if (!stale) action = `shadow:${action}`
        this.record({
          id,
          text: input.text,
          source: input.source,
          state,
          result,
          action,
          elapsedMs: Math.round(this.now() - input.at),
          at: new Date().toISOString(),
        })
        this.changed()
      }),
    ).finally(() => {
      if (epoch !== this.epoch) return
      this.busy = false
      this.changed()
      this.drain()
    })
  }
}
