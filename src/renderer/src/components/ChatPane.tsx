import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useApp } from '../store'
import * as actions from '../actions'
import { Composer } from './Composer'
import { ToolCallCard } from './ToolCallCard'
import { copyText } from '../clipboard'

/** 聊天里的代码块：右上角悬浮复制按钮（复制 <pre> 的纯文本内容） */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLPreElement>(null)

  const copy = async (): Promise<void> => {
    const text = ref.current?.innerText ?? ''
    if (!text) return
    await copyText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="chat-code">
      <button className="copy-btn" onClick={() => void copy()}>
        {copied ? '✓ 已复制' : '复制'}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

export function ChatPane() {
  const {
    projects,
    activeProjectId,
    activeSessionId,
    messages,
    streaming,
    llmProfiles,
    activeLlmId,
    sessionWarning,
    saveError,
    statusText,
  } = useApp()
  const listRef = useRef<HTMLDivElement>(null)
  const activeLlm = llmProfiles.find((p) => p.id === activeLlmId) ?? null
  const [showJumpButton, setShowJumpButton] = useState(false)
  // 记录上一次的会话 id：切换会话（含启动恢复）后强制定位到最新消息
  const sessionRef = useRef<string | null>(activeSessionId)

  // 距底部超过一屏时显示"回到底部"按钮
  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowJumpButton(distance > el.clientHeight)
  }

  // 新消息到达时：贴底（80px 容差）则自动跟随；用户已上滚则不打扰；
  // 会话刚切换（含启动恢复）或用户刚发送消息时无条件定位到底部
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const sessionChanged = sessionRef.current !== activeSessionId
    sessionRef.current = activeSessionId
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const userJustSent = messages[messages.length - 1]?.role === 'user'
    if (sessionChanged || userJustSent || distance <= 80) el.scrollTop = el.scrollHeight
    setShowJumpButton(distance > el.clientHeight)
  }, [messages, activeSessionId])

  // 回到底部：瞬时定位，不做滚动动画
  const jumpToBottom = (): void => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setShowJumpButton(false)
  }

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
        <div className="spacer" />
        {activeSessionId && messages.length > 0 ? (
          <button
            className="btn"
            title="上下文管理：浏览 / 编辑 / 删除消息，管理摘要与压缩（独立窗口）"
            onClick={() => void window.api.openContextWindow()}
          >
            📚 上下文
          </button>
        ) : null}
      </header>

      {saveError ? (
        <div className="chat-banner error">
          <span>
            ⚠ 会话保存失败：{saveError}。新消息目前只存在内存中，请勿关闭应用。
          </span>
          <div className="chat-banner-actions">
            <button className="btn" onClick={() => void actions.retrySaveSession()}>
              重试保存
            </button>
          </div>
        </div>
      ) : null}

      {sessionWarning ? (
        <div className="chat-banner warn">
          <span>{sessionWarning}</span>
          <div className="chat-banner-actions">
            <button className="btn" onClick={() => void actions.revealSessionFile()}>
              在文件夹中显示
            </button>
            <button className="btn" onClick={() => actions.dismissSessionWarning()}>
              知道了
            </button>
          </div>
        </div>
      ) : null}

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
        <div className="message-list-wrap">
          <div className="message-list" ref={listRef} onScroll={onScroll}>
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
                    m.streaming ? <span className="thinking">{statusText || '思考中…'}</span> : null
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
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              rehypePlugins={[rehypeHighlight]}
                              components={{ pre: CodeBlock }}
                            >
                              {b.text}
                            </ReactMarkdown>
                          </div>
                        )
                      }
                      return (
                        <ToolCallCard
                          key={b.id}
                          block={b}
                          onRestore={() => {
                            const p = typeof b.input.path === 'string' ? b.input.path : '(未知文件)'
                            if (
                              window.confirm(
                                `确定把「${p}」回滚到本次修改之前的状态？\n` +
                                  '· write_file 新建的文件将被删除\n· 当前内容也会先被快照，可再次回滚撤销本次操作',
                              )
                            ) {
                              void actions.restoreCheckpoint(b.id)
                            }
                          }}
                        />
                      )
                    })
                  )}
                  {m.streaming && m.blocks.length > 0 ? <span className="cursor">▍</span> : null}
                  {m.error ? <div className="msg-error">出错：{m.error}</div> : null}
                </div>
              </div>
            ))}
          </div>
          {showJumpButton ? (
            <button className="jump-bottom" title="滚到最下面" onClick={jumpToBottom}>
              ↓
            </button>
          ) : null}
        </div>
      )}

      <Composer disabled={streaming} />
    </main>
  )
}
