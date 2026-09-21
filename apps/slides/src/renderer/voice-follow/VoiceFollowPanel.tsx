import { useEffect, useMemo, useRef, useState } from 'react'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { FollowConfigStatus, FollowEngine } from '../../shared/voice-follow'
import { buildFollowCards } from './cards'
import { FollowController, type FollowRecord } from './controller'
import { startMicrophone } from './microphone'

const examples = [
  '接下来讲产品规划。',
  '定价我们稍后再说，先把产品规划讲完。',
  '下面谈基础版和专业版的收费差别。',
  '回到刚才的产品规划，补充一下接口开放的时间。',
]
const actionLabel: Record<string, string> = {
  jump: '已翻页',
  hold: '保持',
  current: '当前页',
  uncertain: '不确定',
  cooldown: '防抖停留',
  expired: '已过期',
  error: '失败',
}

export function VoiceFollowPanel({
  slides,
  notes,
  order,
  current,
  startAt,
  blocked,
  onNavigate,
  onExit,
  registerPause,
}: {
  slides: RenderSlide[]
  notes: string[]
  order: number[]
  current: number
  startAt: number
  blocked: boolean
  onNavigate: (index: number) => void
  onExit: () => void
  registerPause: (pause: (() => void) | null) => void
}) {
  const [, render] = useState(0)
  const [source, setSource] = useState<'text' | 'mic'>('text')
  const [draft, setDraft] = useState('')
  const [settings, setSettings] = useState<FollowConfigStatus | null>(null)
  const [notice, setNotice] = useState('')
  const [listening, setListening] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [device, setDevice] = useState('')
  const [hints, setHints] = useState<Record<string, string>>({})
  const [records, setRecords] = useState<FollowRecord[]>([])
  const allRecords = useRef<FollowRecord[]>([])
  const mounted = useRef(true)
  const callbacks = useRef({ onNavigate, onExit })
  callbacks.current = { onNavigate, onExit }
  const controller = useRef<FollowController | null>(null)
  if (!controller.current)
    controller.current = new FollowController(
      window.slidesApi.voiceFollow,
      (index) => callbacks.current.onNavigate(index),
      () => callbacks.current.onExit(),
      () => {
        if (mounted.current) render((v) => v + 1)
      },
      (record) => {
        allRecords.current.push(record)
        if (mounted.current) setRecords(allRecords.current.slice(-30).reverse())
      },
    )
  const ctrl = controller.current
  const micStop = useRef<(() => void) | null>(null)
  const blockedRef = useRef(blocked)
  blockedRef.current = blocked
  const micEpoch = useRef(0)
  const micBusy = useRef(false)
  const cards = useMemo(
    () => buildFollowCards(slides, notes, order).map((c) => ({ ...c, hint: hints[c.id] ?? '' })),
    [slides, notes, order, hints],
  )
  const stopMic = () => {
    micEpoch.current++
    micStop.current?.()
    micStop.current = null
    micBusy.current = false
    setListening(false)
  }
  useEffect(() => {
    mounted.current = true
    const microphoneGeneration = micEpoch
    const refresh = () => {
      void window.slidesApi.voiceFollow
        .status()
        .then((value) => {
          if (mounted.current) setSettings(value)
        })
        .catch((error) => {
          if (mounted.current) setNotice(String(error))
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      mounted.current = false
      microphoneGeneration.current++
      micStop.current?.()
      ctrl.pause()
    }
  }, [ctrl])
  useEffect(() => {
    ctrl.configure(cards, `page_${current + 1}`)
  }, [cards, current, ctrl])
  useEffect(() => {
    registerPause(() => ctrl.pause('已手动操作，跟随暂停。'))
    return () => registerPause(null)
  }, [ctrl, registerPause])
  useEffect(() => {
    if (blocked) ctrl.pause('黑屏或放映结束，跟随暂停。')
  }, [blocked, ctrl])

  const start = async () => {
    setNotice('')
    if (blockedRef.current) return
    await ctrl.start()
    if (!ctrl.running || source !== 'mic' || micStop.current) return
    const epoch = ++micEpoch.current
    try {
      const stop = await startMicrophone(
        device,
        (wav) => {
          if (epoch !== micEpoch.current) return
          if (micBusy.current) {
            setNotice('语音识别跟不上输入，已跳过一段；请放慢节奏或使用文字模拟。')
            return
          }
          micBusy.current = true
          const started = performance.now()
          void window.slidesApi.voiceFollow
            .transcribe(wav)
            .then((text) => {
              if (epoch !== micEpoch.current || !mounted.current) return
              setDraft(text)
              setNotice(
                `最近转写 ${Math.round(performance.now() - started)} ms；端到端语音延迟尚需回放评测。`,
              )
              if (!blockedRef.current) ctrl.submit(text, 'mic', started)
            })
            .catch((e) => {
              if (epoch === micEpoch.current && mounted.current) setNotice(String(e))
            })
            .finally(() => {
              if (epoch === micEpoch.current) micBusy.current = false
            })
        },
        (message) => {
          if (epoch === micEpoch.current && mounted.current) {
            ctrl.pause(message)
            micStop.current = null
            setListening(false)
          }
        },
      )
      if (!mounted.current || epoch !== micEpoch.current || !ctrl.running) {
        stop()
        return
      }
      micStop.current = stop
      setListening(true)
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'),
      )
    } catch (e) {
      if (epoch === micEpoch.current && mounted.current) {
        ctrl.pause('麦克风未启动。')
        setNotice(String(e))
      }
    }
  }
  const send = () => {
    if (blocked || !draft.trim()) return
    ctrl.submit(draft, 'text')
    setDraft('')
  }
  const exportReport = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            format: 'slides-voice-follow-v1',
            pricingDate: '2026-09-21',
            thresholds: { confidence: 0.8, margin: 0.2, calibrated: false },
            records: allRecords.current,
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
    a.download = 'voice-follow-report.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const totals = allRecords.current.reduce(
    (sum, r) => ({
      input: sum.input + (r.result.usage?.input ?? 0),
      output: sum.output + (r.result.usage?.output ?? 0),
      min: sum.min + (r.result.usage?.costMin ?? 0),
      max: sum.max + (r.result.usage?.costMax ?? 0),
      unknown: sum.unknown + (r.result.usage?.costMin == null ? 1 : 0),
    }),
    { input: 0, output: 0, min: 0, max: 0, unknown: 0 },
  )
  const ready =
    settings &&
    (ctrl.engine === 'jev' ? settings.jevReady : settings.deepseekReady) &&
    (!ctrl.compare || (settings.jevReady && settings.deepseekReady))
  return (
    <section className="vf-panel" aria-label="语音跟随" data-voice-follow>
      <div className="vf-heading">
        <strong>语音跟随（预览版）</strong>
      </div>
      <div className="vf-row">
        <label>
          输入方式
          <select
            aria-label="输入方式"
            value={source}
            onChange={(e) => {
              stopMic()
              ctrl.pause('输入方式已切换，请开始跟随。')
              setSource(e.target.value as 'text' | 'mic')
              setDraft('')
            }}
          >
            <option value="text">文字模拟</option>
            <option value="mic">麦克风</option>
          </select>
        </label>
        <label>
          控制模型
          <select
            aria-label="控制模型"
            value={ctrl.engine}
            onChange={(e) => {
              stopMic()
              ctrl.pause('模型已切换，请开始跟随。')
              ctrl.engine = e.target.value as FollowEngine
              render((v) => v + 1)
            }}
          >
            <option value="jev">Jev 1.13</option>
            <option value="deepseek-flash">DeepSeek Flash</option>
            <option value="deepseek-v4-pro">DeepSeek Pro</option>
          </select>
        </label>
      </div>
      <label className="vf-check">
        <input
          type="checkbox"
          checked={ctrl.compare}
          onChange={(e) => {
            stopMic()
            ctrl.pause()
            ctrl.compare = e.target.checked
            render((v) => v + 1)
          }}
        />
        同时对比 {ctrl.engine === 'jev' ? 'DeepSeek Flash' : 'Jev'}（仅控制模型翻页）
      </label>
      <p className="vf-settings-status">
        Jev：{settings?.jevReady ? '已配置' : '未配置'} · DeepSeek：
        {settings?.deepseekReady ? '已配置' : '未配置'}
        {source === 'mic' && <> · 语音：{settings?.whisperReady ? '已就绪' : '未就绪'}</>}
      </p>
      {(!ready || (source === 'mic' && !settings?.whisperReady)) && (
        <p>请在全局 Settings → AI 模型中管理密钥和语音模型，返回后自动刷新。</p>
      )}
      <details className="vf-cards">
        <summary>页面主题与提示 · {cards.length} 页</summary>
        {cards.map((card) => (
          <label key={card.id}>
            第 {card.index + 1} 页 · {card.title}
            {card.truncated ? '（已截断）' : ''}
            {!card.text && !card.notes ? '（文字不足）' : ''}
            <input
              aria-label={`第 ${card.index + 1} 页提示`}
              value={hints[card.id] ?? ''}
              maxLength={300}
              placeholder="可选：补充本页主题"
              onChange={(e) => {
                stopMic()
                setHints((v) => ({ ...v, [card.id]: e.target.value }))
              }}
            />
          </label>
        ))}
      </details>
      {source === 'text' ? (
        <>
          <label className="vf-input-label">
            模拟演讲内容
            <textarea
              aria-label="模拟演讲内容"
              rows={3}
              maxLength={2000}
              value={draft}
              placeholder="输入一句演讲内容，Enter 发送"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault()
                  send()
                }
              }}
            />
          </label>
          <div className="vf-row">
            <select
              aria-label="快捷示例"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) setDraft(e.target.value)
                e.target.value = ''
              }}
            >
              <option value="">填入快捷示例…</option>
              {examples.map((s, i) => (
                <option key={s} value={s}>
                  {['进入产品规划', '预告定价但不切页', '开始讲套餐收费', '回到产品规划'][i]}
                </option>
              ))}
            </select>
            <button className="vf-primary" disabled={!draft.trim() || blocked} onClick={send}>
              发送
            </button>
          </div>
        </>
      ) : (
        <div>
          <label>
            麦克风
            <select
              aria-label="麦克风"
              disabled={listening}
              value={device}
              onChange={(e) => setDevice(e.target.value)}
            >
              <option value="">系统默认麦克风</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || '麦克风'}
                </option>
              ))}
            </select>
          </label>
          <p>{listening ? '正在监听，包括暂停/继续口令。' : '开始跟随后才申请麦克风权限。'}</p>
          {draft && <p className="vf-transcript">{draft}</p>}
          {listening && (
            <button
              onClick={() => {
                stopMic()
                ctrl.pause('麦克风已关闭。')
              }}
            >
              关闭麦克风
            </button>
          )}
        </div>
      )}
      <div className="vf-row">
        <button
          className="vf-primary"
          disabled={
            blocked ||
            notes.length !== slides.length ||
            !ready ||
            (source === 'mic' && !settings?.whisperReady)
          }
          onClick={() => (ctrl.running ? ctrl.pause() : void start())}
        >
          {ctrl.running ? '暂停跟随' : '开始跟随'}
        </button>
        <button
          onClick={() => {
            stopMic()
            ctrl.reset(startAt)
            setRecords([])
            setDraft('')
          }}
        >
          重新演示
        </button>
      </div>
      <p role="status" aria-live="polite">
        {source === 'text' ? '文字模拟' : '语音输入'} · {ctrl.message}
      </p>
      {notice && <p role="status">{notice}</p>}
      <details className="vf-results">
        <summary>对比详情 · {allRecords.current.length} 次调用</summary>
        <p>
          累计 {totals.input} 输入 / {totals.output} 输出 tokens
        </p>
        <p>
          参考费用 ${totals.min.toFixed(5)}–${totals.max.toFixed(5)}
          {totals.unknown > 0 ? `，另有 ${totals.unknown} 次费用未知` : ''}
        </p>
        <p>按 2026-09-21 峰谷价估算，账单为准。文字模式 ASR：不适用；Jev 阈值尚未校准。</p>
        <button disabled={!allRecords.current.length} onClick={exportReport}>
          导出本次会话报告
        </button>
        {records.map((r) => (
          <article key={r.id}>
            <strong>
              {r.result.model} · {r.action.startsWith('shadow:') ? '旁路 / ' : ''}
              {actionLabel[r.action.replace('shadow:', '')] ?? r.action}
            </strong>
            <p>{r.text}</p>
            <p>
              {r.result.error ||
                (r.result.target === 'NONE'
                  ? '没有唯一匹配页面'
                  : `${r.result.intent} → ${r.state.cards.find((c) => c.id === r.result.target)?.title ?? r.result.target}`)}
            </p>
            <p>
              判断 {Math.round(r.result.elapsedMs)} ms · 提交到结果 {r.elapsedMs} ms
            </p>
            <p>
              {r.result.usage
                ? `${r.result.usage.input} 输入 / ${r.result.usage.output} 输出 · 缓存 ${r.result.usage.cacheHit ?? '未知'}`
                : 'usage 未返回，费用未知'}
            </p>
            <p>
              {r.result.usage?.costMin != null && r.result.usage.costMax != null
                ? `参考费用 $${r.result.usage.costMin.toFixed(6)}–$${r.result.usage.costMax.toFixed(6)}`
                : '参考费用未知'}
            </p>
            {r.result.confidence !== undefined && (
              <p>Jev 置信信号 {r.result.confidence.toFixed(2)}（不是准确率）</p>
            )}
          </article>
        ))}
      </details>
    </section>
  )
}
