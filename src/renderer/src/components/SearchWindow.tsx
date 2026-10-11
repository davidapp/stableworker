import { useState } from 'react'

interface SearchHit {
  projectId: string
  sessionId: string
  sessionTitle: string
  role: string
  text: string
  updatedAt: number
}

/** 全局搜索窗口（独立悬浮窗，?page=search）：跨项目扫描会话消息，点击结果在主窗口打开 */
export function SearchWindow() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [busy, setBusy] = useState(false)

  const search = async (): Promise<void> => {
    const q = query.trim()
    if (!q) return
    setBusy(true)
    try {
      setHits(await window.api.searchAll(q))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ctx-window">
      <header className="inspector-header">
        <h2>全局搜索</h2>
        <span className="hint">跨项目搜索会话消息文本（大小写不敏感，上限 50 条）</span>
        <div className="spacer" />
      </header>

      <div style={{ padding: '0 14px' }}>
        <input
          className="holidays-input"
          style={{ width: '100%' }}
          placeholder={busy ? '搜索中…' : '输入关键词后回车搜索…'}
          value={query}
          disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search()
          }}
          autoFocus
        />
      </div>

      <div className="search-results">
        {hits === null ? (
          <div className="inspector-empty">输入关键词后回车搜索。</div>
        ) : hits.length === 0 ? (
          <div className="inspector-empty">没有匹配的消息。</div>
        ) : (
          hits.map((h, i) => (
            <div
              key={i}
              className="search-hit"
              title="点击在主窗口打开该会话"
              onClick={() => void window.api.openSessionInMain(h.projectId, h.sessionId)}
            >
              <div className="ctx-list-role">
                {h.sessionTitle} · {h.role === 'user' ? '用户' : '助手'} · {new Date(h.updatedAt).toLocaleString()}
              </div>
              <div className="search-hit-text">…{h.text}…</div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
