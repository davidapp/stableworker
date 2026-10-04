import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useApp } from '../store'
import * as actions from '../actions'
import { Composer } from './Composer'
import { ToolCallCard } from './ToolCallCard'
import { ContextMeter } from './ContextMeter'

export function ChatPane() {
  const { projects, activeProjectId, sessions, activeSessionId, messages, streaming, llmProfiles, activeLlmId } =
    useApp()
  const listRef = useRef<HTMLDivElement>(null)
  const activeLlm = llmProfiles.find((p) => p.id === activeLlmId) ?? null

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
        <ContextMeter />
        <div className="spacer" />
        {activeSessionId && messages.length > 0 ? (
          <button
            className="btn"
            title="清空当前会话的消息历史（保留会话，下一句从零开始）"
            onClick={() => {
              if (window.confirm('确定清空当前会话的上下文吗？消息将从会话中移除且不可恢复。')) {
                void actions.clearSessionContext()
              }
            }}
          >
            🧹 清空上下文
          </button>
        ) : null}
        {activeSessionId && (
          <button className="btn btn-danger-ghost" onClick={() => void actions.deleteSession(activeSessionId)}>
            删除会话
          </button>
        )}
      </header>

      {!activeLlm ? (
        <div className="empty-state">
          <p>还没有配置 LLM API。</p>
          <button className="btn btn-primary" onClick={() => actions.openSettings()}>
            打开 LLM 设置
          </button>
        </div>
      ) : messages.length === 0 ? (
        <div className="empty-state">
          <p>开始你的第一轮对话。可以直接问项目相关的问题，助手会调用工具查看文件。</p>
        </div>
      ) : (
        <div className="message-list" ref={listRef}>
          {messages.map((m) => (
            <div key={m.id} className={`message ${m.role}`}>
              <div className={`bubble ${m.role === 'assistant' ? 'md' : ''}`}>
                {m.role === 'user' ? (
                  // 用户消息只含文本块
                  m.blocks
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n')
                ) : m.blocks.length === 0 ? (
                  m.streaming ? <span className="thinking">思考中…</span> : null
                ) : (
                  m.blocks.map((b, i) => {
                    if (b.type === 'reasoning') {
                      return (
                        <details key={i} className="reasoning-collapse">
                          <summary>🤔 思考过程</summary>
                          <div className="reasoning-text">{b.text}</div>
                        </details>
                      )
                    }
                    if (b.type === 'text') {
                      return (
                        <div key={i} className="block-text">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                            {b.text}
                          </ReactMarkdown>
                        </div>
                      )
                    }
                    return <ToolCallCard key={b.id} block={b} />
                  })
                )}
                {m.streaming && m.blocks.length > 0 ? <span className="cursor">▍</span> : null}
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
