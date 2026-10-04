import { useEffect, useState } from 'react'
import { useApp } from '../store'

/**
 * 上下文水位条：显示当前会话的上下文占用。
 * 数据源是最近一次对话请求返回的 usage.prompt_tokens（服务端精确计数，
 * 就是"这轮历史有多大"的真实值），不是本地估算。
 */
export function ContextMeter() {
  const { contextLimit } = useApp()
  const [contextTokens, setContextTokens] = useState<number | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      void window.api.listDebugExchanges().then((list) => {
        const latestChat = list.find((i) => i.kind === 'chat' && i.inputTokens != null)
        setContextTokens(latestChat?.inputTokens ?? null)
      })
    }
    refresh()
    return window.api.onDebugUpdated(refresh)
  }, [])

  if (!contextLimit || contextTokens == null) return null
  const pct = Math.min(100, (contextTokens / contextLimit) * 100)
  // 60% 变黄、80% 变红
  const tone = pct >= 80 ? 'danger' : pct >= 60 ? 'warn' : 'ok'

  return (
    <div
      className="context-meter"
      title={`上下文占用 ${contextTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens（取自最近一次请求的 usage）`}
    >
      <div className="context-meter-bar">
        <div className={`context-meter-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`context-meter-text ${tone}`}>
        {contextTokens.toLocaleString()} / {Math.round(contextLimit / 1000)}k
      </span>
    </div>
  )
}
