import { useState } from 'react'
import { Icon } from './Icon'

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
    <div className="utility-window search-window">
      <header className="utility-header">
        <div className="utility-brand"><Icon name="logo" size={18} /><span>StableWorker</span></div>
        <div className="utility-heading">
          <h2 className="utility-title">全局搜索</h2>
          <span className="utility-subtitle">在所有项目中查找会话消息 · 最多 50 条</span>
        </div>
      </header>

      <form className="search-form" onSubmit={(e) => { e.preventDefault(); void search() }}>
        <div className="search-input-wrap">
          <Icon name="search" size={16} />
          <input
            className="search-input"
            placeholder={busy ? '搜索中…' : '输入关键词搜索消息…'}
            aria-label="搜索所有项目的会话消息"
            value={query}
            disabled={busy}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy || !query.trim()}>
          {busy ? '搜索中…' : '搜索'}
        </button>
      </form>

      {hits !== null ? <div className="search-summary" role="status">{hits.length} 条匹配消息</div> : null}

      <div className="search-results">
        {hits === null ? (
          <div className="inspector-empty"><Icon name="search" size={24} /><span>输入关键词，查找所有项目的消息。</span></div>
        ) : hits.length === 0 ? (
          <div className="inspector-empty"><Icon name="search" size={24} /><span>没有匹配的消息，试试其他关键词。</span></div>
        ) : (
          hits.map((h, i) => (
            <button
              key={i}
              className="search-hit"
              type="button"
              title="点击在主窗口打开该会话"
              onClick={() => void window.api.openSessionInMain(h.projectId, h.sessionId)}
            >
              <span className="search-hit-top">
                <span className="search-hit-title"><Icon name="chat" size={14} />{h.sessionTitle}</span>
                <Icon name="external" size={14} className="search-hit-open" />
              </span>
              <span className="search-hit-meta">{h.role === 'user' ? '用户' : '助手'} · {new Date(h.updatedAt).toLocaleString()}</span>
              <span className="search-hit-text">…{h.text}…</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
