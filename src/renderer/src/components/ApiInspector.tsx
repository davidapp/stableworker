import { useCallback, useEffect, useMemo, useState } from 'react'
import hljs from 'highlight.js/lib/core'
import json from 'highlight.js/lib/languages/json'
import { decimalToPico, picoToDecimalString } from '../../../shared/money'
import type { Currency, DebugDetail, DebugListItem, Money } from '../../../shared/types'
import { copyText } from '../clipboard'

hljs.registerLanguage('json', json)

function moneyLabel(m: Money): string {
  const symbol = m.currency === 'CNY' ? '¥' : '$'
  // amount 本身就是精确的十进制字符串，直接展示，不做任何舍入
  return `${m.source === 'provider' ? '' : '≈'}${symbol}${m.amount}`
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/**
 * 调试面板的内容块：右上角一键复制；json=true 时用 highlight.js 做 JSON 语法高亮。
 * 主题色来自全局引入的 highlight.js github-dark 样式。
 */
function DebugPre({ text, json = false, className = 'debug-pre' }: { text: string; json?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false)
  const html = useMemo(
    () => (json && text ? hljs.highlight(text, { language: 'json' }).value : null),
    [text, json],
  )

  const copy = async (): Promise<void> => {
    await copyText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="copyable-pre">
      <button className="copy-btn" onClick={() => void copy()}>
        {copied ? '✓ 已复制' : '复制'}
      </button>
      {html !== null ? (
        <pre className={className} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className={className}>{text}</pre>
      )}
    </div>
  )
}

export function ApiInspector() {
  const [list, setList] = useState<DebugListItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DebugDetail | null>(null)

  const refreshList = useCallback(async (): Promise<void> => {
    setList(await window.api.listDebugExchanges())
  }, [])

  // 列表底部按币种精确累计（BigInt，无浮点误差）+ tokens 总量
  const totals = new Map<Currency, { pico: bigint; count: number }>()
  let totalTokens = 0
  for (const item of list) {
    totalTokens += (item.inputTokens ?? 0) + (item.outputTokens ?? 0)
    if (!item.cost) continue
    const cur = totals.get(item.cost.currency) ?? { pico: 0n, count: 0 }
    cur.pico += decimalToPico(item.cost.amount)
    cur.count++
    totals.set(item.cost.currency, cur)
  }

  useEffect(() => {
    void refreshList()
    // 选中变化时立即加载详情；流式期间收到 debug:updated 也持续刷新（可实时看到事件流入）
    if (selectedId) void window.api.getDebugExchange(selectedId).then(setDetail)
    return window.api.onDebugUpdated(() => {
      void refreshList()
      if (selectedId) void window.api.getDebugExchange(selectedId).then(setDetail)
    })
  }, [selectedId, refreshList])

  const sseText = detail ? detail.sseEvents.map((l) => `data: ${l}`).join('\n') : ''
  const headersText = detail
    ? Object.entries(detail.requestHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : ''
  const usageText = detail?.usage ? JSON.stringify(detail.usage, null, 2) : ''
  // 测试连接的原始响应：是 JSON 就高亮，否则原样展示
  const responseIsJson =
    detail?.responseBody != null &&
    (() => {
      try {
        JSON.parse(detail.responseBody)
        return true
      } catch {
        return false
      }
    })()

  return (
    <div className="inspector-page">
      <div className="inspector">
        <header className="inspector-header">
          <h2>API 调试日志</h2>
          <span className="hint">记录永久保存在本地 · 密钥已脱敏 · 对话进行中可实时观察事件流</span>
          <div className="spacer" />
          <button
            className="btn"
            onClick={() => {
              if (window.confirm('确定清空全部 API 调用记录？磁盘上的日志文件也会一并删除，不可恢复。')) {
                void window.api.clearDebugLog()
              }
            }}
          >
            清空
          </button>
        </header>

        <div className="inspector-body">
          <aside className="inspector-list">
            {list.length === 0 ? (
              <div className="inspector-empty">还没有 API 调用记录，去发一条消息或点一次"测试连接"。</div>
            ) : (
              list.map((item) => (
                <div
                  key={item.id}
                  className={`inspector-item ${item.id === selectedId ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedId(item.id)
                    setDetail(null)
                  }}
                >
                  <div className="inspector-item-top">
                    <span className="badge">{item.kind === 'test' ? '测试' : '对话'}</span>
                    <span className="badge model" title={item.url}>
                      {item.model || '(未设模型)'}
                    </span>
                    <span className={`status ${item.error ? 'err' : ''}`}>
                      {item.error ? '失败' : (item.status ?? '进行中…')}
                    </span>
                  </div>
                  <div className="inspector-item-sub">
                    {new Date(item.startedAt).toLocaleTimeString()}
                    {item.round > 1 ? ` · R${item.round}` : ''}
                    {item.trimmedCount ? ` · 已裁剪 ${item.trimmedCount} 条` : ''}
                    {` · ${item.eventCount} 个事件`}
                    {item.durationMs != null ? ` · ${item.durationMs}ms` : ''}
                    {item.cost ? ` · ${moneyLabel(item.cost)}` : ''}
                  </div>
                </div>
              ))
            )}
            {list.length > 0 ? (
              <footer className="inspector-total">
                共 {list.length} 次调用 · {totalTokens.toLocaleString()} tokens
                {totals.size > 0
                  ? ' · ' +
                    [...totals.entries()]
                      .map(([currency, t]) => {
                        const symbol = currency === 'CNY' ? '¥' : '$'
                        const approx = list.some(
                          (i) => i.cost?.currency === currency && i.cost.source === 'estimated',
                        )
                        return `${approx ? '≈' : ''}${symbol}${picoToDecimalString(t.pico)}（${t.count} 次）`
                      })
                      .join('，')
                  : ''}
              </footer>
            ) : null}
          </aside>

          <section className="inspector-detail">
            {!detail ? (
              <div className="inspector-empty">选择左侧一条记录，查看原始请求与响应。</div>
            ) : (
              <>
                <h3>请求 {detail.kind === 'test' ? '（测试连接，非流式）' : `（对话，流式${detail.round > 1 ? ` · 第 ${detail.round} 轮` : ''}）`}</h3>
                <DebugPre text={`${detail.method} ${detail.url}`} />
                <div className="hint-line">
                  {detail.proxyURL ? `经代理发送：${detail.proxyURL}` : '直连（未配置代理）'}
                </div>
                <DebugPre text={headersText} />
                <DebugPre text={detail.requestBody} json />

                {detail.responseBody != null ? (
                  <>
                    <h3>响应体（非流式原始响应）</h3>
                    {responseIsJson ? (
                      <DebugPre json text={prettyJson(detail.responseBody)} />
                    ) : (
                      <DebugPre text={detail.responseBody} />
                    )}
                  </>
                ) : null}

                {detail.kind === 'chat' ? (
                  <>
                    <h3>回复内容（从流式增量拼装）</h3>
                    <DebugPre
                      text={
                        detail.assembledText ||
                        (detail.reasoningText || detail.toolCalls.length
                          ? '（本轮无正文：模型只输出了思考内容和/或工具调用）'
                          : '（空）')
                      }
                    />

                    {detail.toolCalls.length > 0 ? (
                      <>
                        <h3>本轮发起的工具调用（{detail.toolCalls.length} 个，结果见下一轮请求体 / 聊天气泡）</h3>
                        {detail.toolCalls.map((c) => (
                          <div key={c.id}>
                            <div className="hint-line">
                              {`${c.name}  (id: ${c.id})`}
                            </div>
                            <DebugPre json text={prettyJson(c.argsJson)} />
                          </div>
                        ))}
                      </>
                    ) : null}

                {detail.reasoningText ? (
                  <>
                    <h3>思考过程（reasoning_content / thinking，DeepSeek 要求随历史回传）</h3>
                    <DebugPre text={detail.reasoningText} />
                  </>
                ) : null}
                  </>
                ) : null}

                <details className="sse-details">
                  <summary>展开详情：token 用量 / 计费 / 原始 SSE 事件（{detail.eventCount} 条）</summary>

                  <div className="hint-line">
                    计费档位：{detail.peak ? '高峰时段' : '空闲时段'}（按请求发起时刻的北京时间判定）
                  </div>
                  <DebugPre
                    json
                    text={`{\n  "input_tokens": ${detail.inputTokens ?? '未返回'},\n  "output_tokens": ${detail.outputTokens ?? '未返回'},\n  "cost": ${JSON.stringify(detail.cost ?? '未计费')}\n}`}
                  />

                  {usageText ? (
                    <>
                      <div className="hint-line">原始 usage：</div>
                      <DebugPre json text={usageText} />
                    </>
                  ) : null}

                  <div className="hint-line">
                    SSE 事件流（每行就是一条 "data: ..." 原始消息；OpenAI 系看 choices[0].delta.content，
                    Anthropic 看 type=content_block_delta 的 delta.text）：
                  </div>
                  <DebugPre className="debug-pre sse" text={sseText || '（还没有收到事件）'} />
                </details>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
