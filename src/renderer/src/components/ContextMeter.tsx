import { useEffect, useState } from 'react'
import type { DebugListItem } from '../../../shared/types'
import { selectContextExchange } from '../../../shared/contextUsage'
import { useApp } from '../store'
import { t } from '../i18n'
import * as actions from '../actions'
import { Icon } from './Icon'

const fmtPct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`
const fmtNum = (n: number): string => n.toLocaleString()
const fmtLimit = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : fmtNum(n)

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

/** Verified model capacity and server usage for this exact conversation/model, with provenance. */
export function ContextMeter() {
  const { contextLimit, contextInfo, activeSessionId, activeLlmId, llmProfiles } = useApp()
  const [open, setOpen] = useState(false)
  const [latest, setLatest] = useState<DebugListItem | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')
  const active = llmProfiles.find((p) => p.id === activeLlmId)

  useEffect(() => {
    let disposed = false
    setLatest(null)
    setNotice('')
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
  const sourceLabel = contextInfo?.source === 'api' ? t('服务返回的模型元数据') : contextInfo?.source === 'official-docs' ? t('已核实的官方文档') : contextInfo?.source === 'manual' ? t('手动配置') : t('尚未获得该模型的容量')
  const canLink = contextInfo?.sourceUrl && /^https?:\/\//.test(contextInfo.sourceUrl)
  const tokenLabel = contextTokens != null ? `${fmtNum(contextTokens)} / ${contextLimit ? fmtLimit(contextLimit) : '?'}` : contextLimit ? `上下文 ${fmtLimit(contextLimit)}` : '上限未确认'

  return (
    <div className="mode-menu-wrap">
      <button className="mode-btn context-meter-btn" aria-expanded={open}
        title={`上下文容量：${contextLimit ? `${fmtNum(contextLimit)} tokens` : '未确认'}，点击{t('查看来源')}与刷新`}
        onClick={() => setOpen((v) => !v)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={ringR} fill="none" stroke="var(--border-strong)" strokeWidth="2.5" />
          {hasRatio ? <circle cx="8" cy="8" r={ringR} fill="none" stroke={`var(--${tone})`} strokeWidth="2.5"
            strokeLinecap="round" strokeDasharray={ringC} strokeDashoffset={ringC * (1 - pct / 100)} transform="rotate(-90 8 8)" /> : null}
        </svg>
        <span className={`context-meter-text ${tone}`}>{tokenLabel}</span>
      </button>
      {open ? (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="mode-menu ctx-popover">
            <div className="ctx-title-row">
              <span>{t('上下文容量')}</span>
              <span className="ctx-value">{contextLimit ? `${fmtNum(contextLimit)} tokens` : '上限未确认'}</span>
            </div>
            <div className="ctx-capacity-source">
              <span>{sourceLabel}</span>
              {contextInfo?.checkedAt ? <span>{t('核实于')} {new Date(contextInfo.checkedAt).toLocaleDateString()}</span> : null}
              {canLink ? <a href={contextInfo.sourceUrl} target="_blank" rel="noreferrer">{t('查看来源')} <Icon name="external" size={11} /></a> : null}
              {contextInfo?.maxOutputTokens ? <span>{t('输出上限：')}{fmtNum(contextInfo.maxOutputTokens)} tokens</span> : null}
            </div>
            <div className="ctx-row">
              <span className="ctx-label">{t('当前会话输入用量')}</span>
              <span className="ctx-value">{contextTokens != null ? `${fmtNum(contextTokens)}${hasRatio ? `（${fmtPct(contextTokens / contextLimit)}）` : ''}` : t('等待本会话请求完成')}</span>
            </div>
            {breakdown ? (
              <>
                <div className="ctx-divider" />
                <div className="ctx-total-bar">
                  {[['messagesTokens', 'var(--chart-messages)'], ['toolsTokens', 'var(--chart-tools)'], ['systemTokens', 'var(--chart-system)']].map(([field, color]) => (
                    <span key={field} className="ctx-seg" style={{ width: `${breakdown.totalTokens > 0 ? (breakdown[field as 'messagesTokens' | 'toolsTokens' | 'systemTokens'] / breakdown.totalTokens) * 100 : 0}%`, background: color }} />
                  ))}
                </div>
                <div className="ctx-rows">
                  <BreakdownRow color="var(--chart-messages)" label="消息" tokens={breakdown.messagesTokens} total={breakdown.totalTokens} />
                  <BreakdownRow color="var(--chart-tools)" label="系统工具" tokens={breakdown.toolsTokens} total={breakdown.totalTokens} />
                  <BreakdownRow color="var(--chart-system)" label="系统提示词" tokens={breakdown.systemTokens} total={breakdown.totalTokens} />
                  <div className="ctx-capacity-source">输入总量由服务返回；各部分占比为本地估算。</div>
                  <div className="ctx-row"><span className="ctx-label">输出（最近一轮）</span><span className="ctx-value">{fmtNum(latest?.outputTokens ?? 0)}</span></div>
                  <div className="ctx-row"><span className="ctx-label">缓存命中率</span><span className="ctx-value">{breakdown.cacheHitRate != null ? fmtPct(breakdown.cacheHitRate) : '—'}（命中 {fmtNum(breakdown.cacheHitTokens ?? 0)}）</span></div>
                </div>
              </>
            ) : null}
            <div className="ctx-divider" />
            <button className="btn btn-ghost" disabled={refreshing} onClick={async () => {
              setRefreshing(true)
              const result = await actions.refreshModelContext()
              setNotice(result.message)
              setRefreshing(false)
            }}><Icon name="refresh" size={14} />{refreshing ? t('正在获取…') : t('从服务刷新容量')}</button>
            {notice ? <div className="ctx-capacity-source" role="status">{notice}</div> : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
