import { useCallback, useEffect, useState } from 'react'
import type { DebugDetail, DebugListItem } from '../../../shared/types'
import * as actions from '../actions'

function formatCost(d: DebugDetail): string {
  if (d.costUSD == null) return '未计费（未返回 usage 或未配置模型单价）'
  const amount = `$${d.costUSD.toFixed(6)}`
  return d.costSource === 'provider' ? `${amount}（服务方报告）` : `≈${amount}（按配置单价估算）`
}

/**
 * API 调试面板：观察每次 LLM 调用的原始请求/响应。
 * 学习要点：请求 JSON 的形状、SSE "data:" 逐行事件流、最终文本如何从增量拼装出来。
 * 数据在主进程内存里（重启清空），密钥已脱敏。
 */
export function ApiInspector() {
  const [list, setList] = useState<DebugListItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DebugDetail | null>(null)

  const refreshList = useCallback(async (): Promise<void> => {
    setList(await window.api.listDebugExchanges())
  }, [])

  const totalCost = list.reduce((sum, i) => sum + (i.costUSD ?? 0), 0)
  const costedCount = list.filter((i) => i.costUSD != null).length

  useEffect(() => {
    void refreshList()
    // 依赖 selectedId：切换选中或收到 debug:updated 时重取详情（可实时看到事件流入）
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
                    {item.costUSD != null
                      ? ` · ${item.costSource === 'provider' ? '' : '≈'}$${item.costUSD.toFixed(6)}`
                      : ''}
                  </div>
                </div>
              ))
            )}
            {list.length > 0 ? (
              <footer className="inspector-total">
                共 {list.length} 次调用
                {costedCount > 0
                  ? ` · 花费合计 $${totalCost.toFixed(4)}${costedCount < list.length ? '（部分未计费）' : ''}`
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

                <h3>响应</h3>
                {detail.error ? <div className="msg-error">出错：{detail.error}</div> : null}
                {detail.responseBody != null ? (
                  <pre className="debug-pre">{detail.responseBody}</pre>
                ) : (
                  <>
                    <div className="hint-line">
                      SSE 事件流（每行就是一条 "data: ..." 原始消息；OpenAI 系看 choices[0].delta.content，Anthropic
                      看 type=content_block_delta 的 delta.text）：
                    </div>
                    <pre className="debug-pre sse">
                      {detail.sseEvents.length
                        ? detail.sseEvents.map((l) => `data: ${l}`).join('\n')
                        : '（还没有收到事件）'}
                    </pre>
                  </>
                )}
                {detail.inputTokens != null || detail.usage ? (
                  <pre className="debug-pre">
                    {`输入 tokens: ${detail.inputTokens ?? '未返回'}\n输出 tokens: ${detail.outputTokens ?? '未返回'}\n花费: ${formatCost(detail)}\n\n原始 usage:\n${detail.usage ? JSON.stringify(detail.usage, null, 2) : '（无）'}`}
                  </pre>
                ) : null}

                <h3>从增量拼装出的最终文本</h3>
                <pre className="debug-pre">{detail.assembledText || '（空）'}</pre>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
