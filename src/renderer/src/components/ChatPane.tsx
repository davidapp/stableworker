import { useEffect, useRef } from 'react'
import { useApp } from '../store'
import * as actions from '../actions'
import { Composer } from './Composer'

export function ChatPane() {
  const { projects, activeProjectId, sessions, activeSessionId, messages, streaming, llm } = useApp()
  const listRef = useRef<HTMLDivElement>(null)

  // 消息变化时自动滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const project = projects.find((p) => p.id === activeProjectId)

  if (!project) {
    return (
      <main className="chat-pane">
        <div className="empty-state">
          <h2>欢迎使用 StableWorker</h2>
          <p>先在左侧添加一个项目目录，然后就可以开始对话了。</p>
          <button className="btn btn-primary" onClick={() => void actions.addProject()}>
            ＋ 添加项目
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="chat-pane">
      <header className="chat-header">
        <span className="chat-header-project" title={project.path}>
          {project.name}
        </span>
        <select
          className="session-select"
          value={activeSessionId ?? ''}
          onChange={(e) => {
            if (e.target.value) void actions.selectSession(e.target.value)
          }}
        >
          <option value="" disabled>
            选择会话
          </option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => actions.newSession()}>
          ＋ 新会话
        </button>
        <div className="spacer" />
        {activeSessionId && (
          <button className="btn btn-danger-ghost" onClick={() => void actions.deleteSession(activeSessionId)}>
            删除会话
          </button>
        )}
      </header>

      {!llm ? (
        <div className="empty-state">
          <p>还没有配置 LLM API。</p>
          <button className="btn btn-primary" onClick={() => actions.openSettings()}>
            打开 LLM 设置
          </button>
        </div>
      ) : messages.length === 0 ? (
        <div className="empty-state">
          <p>开始你的第一轮对话。</p>
        </div>
      ) : (
        <div className="message-list" ref={listRef}>
          {messages.map((m) => (
            <div key={m.id} className={`message ${m.role}`}>
              <div className="bubble">
                {m.content || (m.streaming ? '思考中…' : '')}
                {m.streaming && m.content ? <span className="cursor">▍</span> : null}
                {m.error ? <div className="msg-error">出错：{m.error}</div> : null}
              </div>
            </div>
          ))}
        </div>
      )}

      <Composer disabled={streaming} />
    </main>
  )
}
