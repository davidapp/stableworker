import { useEffect, useState } from 'react'
import type { DebugListItem } from '../../../shared/types'
import { selectContextExchange } from '../../../shared/contextUsage'
import { useApp } from '../store'
import { t } from '../i18n'

const fmtPct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`
const fmtNum = (n: number): string => n.toLocaleString()

function BreakdownRow({ color, label, tokens, total }: { color: string; label: string; tokens: number; total: number }) {
  const pct = total > 0 ? tokens / total : 0
  return (
    <div className="ctx-row">
      <span className="ctx-dot" style={{ background: color, opacity: pct > 0 ? 1 : 0.35 }} />
      <span className="ctx-label">{label}</span>
      <span className="ctx-value">{tokens > 0 ? `${fmtPct(pct)}（${fmtNum(tokens)}）` : '0%'}</span>
    </div>
  )
}

/** 上下文水位环：只显示数字（总量 / 已用 / 输出上限 / 构成占比 / 缓存命中） */
export function ContextMeter() {
  const { contextLimit, contextInfo, activeSessionId, activeLlmId, llmProfiles } = useApp()
  const [open, setOpen] = useState(false)
  const [latest, setLatest] = useState<DebugListItem | null>(null)
  const active = llmProfiles.find((p) => p.id === activeLlmId)

  useEffect(() => {
    let disposed = false
    setLatest(null)
    const refresh = (): void => {
      void window.api.listDebugExchanges().then((list) => {
        if (!disposed) setLatest(selectContextExchange(list, activeSessionId, active))
      }).catch(() => { if (!disposed) setLatest(null) })
    }
    refresh()
    const off = window.api.onDebugUpdated(refresh)
    return () => { disposed = true; off() }
  }, [activeSessionId, activeLlmId, active?.model, active?.baseURL, active?.provider])

  if (!active) return null
  const contextTokens = latest?.inputTokens ?? null
  const breakdown = latest?.breakdown ?? null
  const hasRatio = contextLimit > 0 && contextTokens != null
  const pct = hasRatio ? Math.min(100, contextTokens / contextLimit * 100) : 0
  const tone = hasRatio ? pct >= 80 ? 'danger' : pct >= 60 ? 'warn' : 'ok' : 'muted'
  const ringR = 6
  const ringC = 2 * Math.PI * ringR

  return (
    <div className="mode-menu-wrap align-right">
      <button className="mode-btn context-meter-btn" aria-expanded={open}
        title={hasRatio ? `${t('上下文')} ${fmtPct(pct / 100)}` : t('上下文')}
        onClick={() => setOpen((v) => !v)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={ringR} fill="none" stroke="var(--border-strong)" strokeWidth="2.5" />
          {hasRatio ? <circle cx="8" cy="8" r={ringR} fill="none" stroke={`var(--${tone})`} strokeWidth="2.5"
            strokeLinecap="round" strokeDasharray={ringC} strokeDashoffset={ringC * (1 - pct / 100)} transform="rotate(-90 8 8)" /> : null}
        </svg>
      </button>
      {open ? (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="mode-menu ctx-popover">
            <div className="ctx-title-row">
              <span>{t('已用')}</span>
              <span className="ctx-value">{contextTokens != null ? `${fmtNum(contextTokens)} / ${contextLimit ? fmtNum(contextLimit) : '?'}` : '—'}</span>
            </div>
            {contextInfo?.maxOutputTokens ? (
              <div className="ctx-row">
                <span className="ctx-label">{t('输出上限')}</span>
                <span className="ctx-value">{fmtNum(contextInfo.maxOutputTokens)}</span>
              </div>
            ) : null}
            {breakdown ? (
              <>
                <div className="ctx-divider" />
                <div className="ctx-total-bar">
                  {[['messagesTokens', 'var(--chart-messages)'], ['toolsTokens', 'var(--chart-tools)'], ['systemTokens', 'var(--chart-system)']].map(([field, color]) => (
                    <span key={field} className="ctx-seg" style={{ width: `${breakdown.totalTokens > 0 ? (breakdown[field as 'messagesTokens' | 'toolsTokens' | 'systemTokens'] / breakdown.totalTokens) * 100 : 0}%`, background: color }} />
                  ))}
                </div>
                <div className="ctx-rows">
                  <BreakdownRow color="var(--chart-messages)" label={t('消息')} tokens={breakdown.messagesTokens} total={breakdown.totalTokens} />
                  <BreakdownRow color="var(--chart-tools)" label={t('系统工具')} tokens={breakdown.toolsTokens} total={breakdown.totalTokens} />
                  <BreakdownRow color="var(--chart-system)" label={t('系统提示词')} tokens={breakdown.systemTokens} total={breakdown.totalTokens} />
                  <div className="ctx-row"><span className="ctx-label">{t('输出（最近一轮）')}</span><span className="ctx-value">{fmtNum(latest?.outputTokens ?? 0)}</span></div>
                  <div className="ctx-row"><span className="ctx-label">{t('缓存命中率')}</span><span className="ctx-value">{breakdown.cacheHitRate != null ? fmtPct(breakdown.cacheHitRate) : '—'}</span></div>
                </div>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
