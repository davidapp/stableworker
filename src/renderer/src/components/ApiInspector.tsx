import { useCallback, useEffect, useState } from 'react'
import { decimalToPico, picoToDecimalString } from '../../../shared/money'
import type { Currency, DebugDetail, DebugListItem, Money } from '../../../shared/types'
import * as actions from '../actions'

function moneyLabel(m: Money): string {
  const symbol = m.currency === 'CNY' ? '¥' : '$'
  // amount 本身就是精确的十进制字符串，直接展示，不做任何舍入
  return `${m.source === 'provider' ? '' : '≈'}${symbol}${m.amount}`
}

export function ApiInspector() {
  const [list, setList] = useState<DebugListItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DebugDetail | null>(null)

  const refreshList = useCallback(async (): Promise<void> => {
    setList(await window.api.listDebugExchanges())
  }, [])

  // 列表底部按币种精确累计（BigInt，无浮点误差）
  const totals = new Map<Currency, { pico: bigint; count: number }>()
  for (const item of list) {
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

  return (
    <div className="modal-overlay" onClick={() => actions.closeInspector()}>
      <div className="inspector" onClick={(e) => e.stopPropagation()}>
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
          <button className="btn" onClick={() => actions.closeInspector()}>
            关闭
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
                    {new Date(item.startedAt).toLocaleTimeString()} · {item.eventCount} 个事件
                    {item.durationMs != null ? ` · ${item.durationMs}ms` : ''}
                    {item.cost ? ` · ${moneyLabel(item.cost)}` : ''}
                  </div>
                </div>
              ))
            )}
            {list.length > 0 ? (
              <footer className="inspector-total">
                共 {list.length} 次调用
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
                <h3>请求 {detail.kind === 'test' ? '（测试连接，非流式）' : '（对话，流式）'}</h3>
                <pre className="debug-pre">
                  {detail.method} {detail.url}
                </pre>
                <div className="hint-line">
                  {detail.proxyURL ? `经代理发送：${detail.proxyURL}` : '直连（未配置代理）'}
                </div>
                <pre className="debug-pre">
                  {Object.entries(detail.requestHeaders)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n')}
                </pre>
                <pre className="debug-pre">{detail.requestBody}</pre>

                <h3>回复内容（从流式增量拼装）</h3>
                <pre className="debug-pre">
                  {detail.assembledText ||
                    (detail.reasoningText
                      ? '（本轮无正文：模型只输出了思考内容和/或工具调用）'
                      : '（空）')}
                </pre>

                {detail.reasoningText ? (
                  <>
                    <h3>思考过程（reasoning_content，按协议约定不回传给模型）</h3>
                    <pre className="debug-pre">{detail.reasoningText}</pre>
                  </>
                ) : null}

                <details className="sse-details">
                  <summary>
                    展开详情：token 用量 / 计费 / 原始 SSE 事件（{detail.eventCount} 条）
                  </summary>

                  <div className="hint-line">
                    计费档位：{detail.peak ? '高峰时段' : '空闲时段'}（按请求发起时刻的北京时间判定）
                  </div>
                  <pre className="debug-pre">
                    {`输入 tokens: ${detail.inputTokens ?? '未返回'}${
                      detail.cacheHitTokens != null
                        ? `（缓存命中 ${detail.cacheHitTokens} + 未命中 ${detail.cacheMissTokens ?? '?'}）`
                        : ''
                    }\n输出 tokens: ${detail.outputTokens ?? '未返回'}\n花费: ${
                      detail.cost ? moneyLabel(detail.cost) : '未计费（未返回 usage 或未配置该模型价格）'
                    }`}
                  </pre>

                  <div className="hint-line">
                    SSE 事件流（每行就是一条 "data: ..." 原始消息；OpenAI 系看 choices[0].delta.content，
                    Anthropic 看 type=content_block_delta 的 delta.text）：
                  </div>
                  <pre className="debug-pre sse">
                    {detail.sseEvents.length
                      ? detail.sseEvents.map((l) => `data: ${l}`).join('\n')
                      : '（还没有收到事件）'}
                  </pre>

                  {detail.usage ? (
                    <pre className="debug-pre">{`原始 usage:\n${JSON.stringify(detail.usage, null, 2)}`}</pre>
                  ) : null}
                </details>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
