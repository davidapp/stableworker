import { useEffect, useState } from 'react'
import type { ContextBreakdown, DebugListItem } from '../../../shared/types'
import { useApp } from '../store'

const fmtPct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`
const fmtNum = (n: number): string => n.toLocaleString()

/** 明细行：彩色圆点 + 名称 + 占比 */
function BreakdownRow({ color, label, tokens, total }: { color: string; label: string; tokens: number; total: number }) {
  const pct = total > 0 ? tokens / total : 0
  return (
    <div className="ctx-row">
      <span className="ctx-dot" style={{ background: color, opacity: pct > 0 ? 1 : 0.35 }} />
      <span className="ctx-label">{label}</span>
      <span className="ctx-value">
        {tokens > 0 ? `${fmtPct(pct)}（${fmtNum(tokens)}）` : '0%'}
      </span>
    </div>
  )
}

/**
 * 上下文水位条：显示当前会话的上下文占用；点击弹出构成明细。
 * 总量/缓存命中率是服务端精确值（usage）；消息/系统工具/系统提示词的
 * 拆分为本地估算（API 不返回逐段计数），供观察量级使用。
 */
export function ContextMeter() {
  const { contextLimit } = useApp()
  const [open, setOpen] = useState(false)
  const [latest, setLatest] = useState<DebugListItem | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      void window.api.listDebugExchanges().then((list) => {
        setLatest(list.find((i) => i.kind === 'chat' && i.inputTokens != null) ?? null)
      })
    }
    refresh()
    return window.api.onDebugUpdated(refresh)
  }, [])

  const contextTokens = latest?.inputTokens ?? null
  const breakdown: ContextBreakdown | null = latest?.breakdown ?? null

  if (!contextLimit || contextTokens == null) return null
  const pct = Math.min(100, (contextTokens / contextLimit) * 100)
  const tone = pct >= 80 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
  const toneColor = tone === 'danger' ? '#e5484d' : tone === 'warn' ? '#f5a623' : '#3dd68c'
  // 环形进度：整圈周长按占用比例显示
  const ringR = 6
  const ringC = 2 * Math.PI * ringR

  return (
    <div className="mode-menu-wrap">
      <button
        className="mode-btn context-meter-btn"
        title={
          breakdown
            ? '上下文占用，点击查看构成明细'
            : '上下文占用（下一轮请求完成后可查看构成明细）'
        }
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={ringR} fill="none" stroke="#3a3e46" strokeWidth="2.5" />
          <circle
            cx="8"
            cy="8"
            r={ringR}
            fill="none"
            stroke={toneColor}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={ringC}
            strokeDashoffset={ringC * (1 - pct / 100)}
            transform="rotate(-90 8 8)"
          />
        </svg>
        <span className={`context-meter-text ${tone}`}>
          {fmtNum(contextTokens)} / {Math.round(contextLimit / 1000)}k
        </span>
      </button>

      {open ? (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="mode-menu ctx-popover">
            <div className="ctx-title-row">
              <span>上下文容量</span>
              <span className="ctx-value">
                {fmtNum(contextTokens)} / {fmtNum(contextLimit)}（{fmtPct(contextTokens / contextLimit)}）
              </span>
            </div>
            <div className="ctx-total-bar">
              {breakdown ? (
                <>
                  <span
                    className="ctx-seg"
                    style={{ width: `${(breakdown.messagesTokens / breakdown.totalTokens) * 100}%`, background: '#5b8cff' }}
                  />
                  <span
                    className="ctx-seg"
                    style={{ width: `${(breakdown.toolsTokens / breakdown.totalTokens) * 100}%`, background: '#b07ee0' }}
                  />
                  <span
                    className="ctx-seg"
                    style={{ width: `${(breakdown.systemTokens / breakdown.totalTokens) * 100}%`, background: '#3dd6c8' }}
                  />
                </>
              ) : (
                <span className="ctx-seg" style={{ width: '100%', background: '#5b8cff' }} />
              )}
            </div>

            {breakdown ? (
              <div className="ctx-rows">
                <BreakdownRow color="#5b8cff" label="消息" tokens={breakdown.messagesTokens} total={breakdown.totalTokens} />
                <BreakdownRow color="#b07ee0" label="系统工具" tokens={breakdown.toolsTokens} total={breakdown.totalTokens} />
                <BreakdownRow color="#3dd6c8" label="系统提示词" tokens={breakdown.systemTokens} total={breakdown.totalTokens} />
                <div className="ctx-row">
                  <span className="ctx-dot" style={{ background: 'transparent' }} />
                  <span className="ctx-label">输出（最近一轮）</span>
                  <span className="ctx-value">{fmtNum(latest?.outputTokens ?? 0)}</span>
                </div>
                <div className="ctx-divider" />
                <div className="ctx-row">
                  <span className="ctx-dot" style={{ background: '#3dd68c' }} />
                  <span className="ctx-label">缓存命中率</span>
                  <span className="ctx-value">
                    {breakdown.cacheHitRate != null ? fmtPct(breakdown.cacheHitRate) : '—'}（命中{' '}
                    {fmtNum(breakdown.cacheHitTokens ?? 0)}）
                  </span>
                </div>
              </div>
            ) : (
              <div className="ctx-rows">
                <div className="ctx-row">
                  <span className="ctx-label">明细将在下一轮请求完成后可用</span>
                </div>
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
