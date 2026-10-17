import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { OfficeFile } from '../../../shared/types'
import { useApp, store } from '../store'
import * as actions from '../actions'
import { Composer } from './Composer'
import { ToolCallCard } from './ToolCallCard'
import { TodoPanel } from './TodoPanel'
import { copyText } from '../clipboard'
import { Icon } from './Icon'
import { t } from '../i18n'
import { OfficePanel } from './OfficePanel'
import { FileExplorerPanel } from './FileExplorerPanel'

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
    sessionsByProject,
    taskMode,
    preferences,
  } = useApp()
  const listRef = useRef<HTMLDivElement>(null)
  const activeLlm = llmProfiles.find((p) => p.id === activeLlmId) ?? null
  const [showJumpButton, setShowJumpButton] = useState(false)
  // 窗口最大化状态（隐藏标题栏的自定义窗口控制按钮切换图标用）
  const [maximized, setMaximized] = useState(false)
  useEffect(() => window.api.onMaximizeChange(setMaximized), [])
  const [attachments, setAttachments] = useState<OfficeFile[]>([])
  const [fileRefresh, setFileRefresh] = useState(0)
  const [importError, setImportError] = useState('')
  const [taskDraft, setTaskDraft] = useState<{ id: number; text: string } | null>(null)
  const office = taskMode === 'office'
  useEffect(() => { setAttachments([]); setImportError(''); setTaskDraft(null) }, [activeSessionId, taskMode])
  const importFiles = async (): Promise<void> => {
    if (streaming) return
    try {
      const id = await actions.ensureOfficeSession()
      const imported = await window.api.office.import(id)
      if (store.getState().activeSessionId !== id) return
      setAttachments((prev) => [...prev, ...imported.filter((f) => !prev.some((p) => p.path === f.path))])
      setFileRefresh((n) => n + 1)
      setImportError('')
    } catch (err) { if (store.getState().taskMode === 'office') setImportError(err instanceof Error ? err.message : String(err)) }
  }
  const sendOffice = (text: string): void => {
    const refs = attachments.map((f) => `- ${f.name}: ${f.path}`).join('\n')
    void actions.sendChat(`${text}${refs ? `\n\n本次参考资料（请使用 office_read_document 读取）：\n${refs}` : ''}`)
    setAttachments([])
  }
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
  const session = project ? sessionsByProject[project.id]?.find((s) => s.id === activeSessionId) : null

  if (!project) {
    return (
      <main className="chat-pane">
        <header className="chat-header"><Icon name="folder" /><span className="chat-header-project">工作区</span></header>
        <div className="empty-state">
          <span className="empty-state-icon"><Icon name="code" size={28} /></span>
          <span className="empty-state-eyebrow">你的 AI 编程工作区</span>
          <h2>从一个项目开始</h2>
          <p>添加本地项目目录，与助手一起阅读代码、规划修改和完成开发。</p>
          <button className="btn btn-primary" onClick={() => void actions.addProject()}>
            <Icon name="plus" /> 添加项目
          </button>
        </div>
      </main>
    )
  }

  return (
    <div className={office ? 'office-workbench' : 'chat-workbench'}>
    <main className="chat-pane">
      <header className="chat-header">
        <Icon name={office ? 'briefcase' : 'folder'} />
        <span className="chat-header-project" title={project.path}>
          {office ? t('办公') : project.name}
        </span>
        <span className="header-separator">/</span>
        <span className="chat-header-session">{session?.title ?? t('新会话')}</span>
        <div className="spacer" />
        {activeSessionId && messages.length > 0 ? (
          <button
            className="btn btn-ghost"
            title="上下文管理：浏览 / 编辑 / 删除消息，管理摘要与压缩（独立窗口）"
            onClick={() => void window.api.openContextWindow()}
          >
            <Icon name="list" size={14} /> {t('上下文')}
          </button>
        ) : null}
        <div className="win-controls">
          <button className="win-btn" title={t('最小化')} aria-label={t('最小化')} onClick={() => void window.api.minimizeWindow()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button className="win-btn" title={t('最大化')} aria-label={t('最大化')} onClick={() => void window.api.maximizeToggleWindow()}>
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 0h8v8M0 2h8v8H0z" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
            )}
          </button>
          <button className="win-btn win-close" title={t('关闭')} aria-label={t('关闭')} onClick={() => void window.api.closeWindow()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
        </div>
      </header>

      {importError && <div className="chat-banner error" role="alert">导入失败：{importError}</div>}

      {saveError ? (
        <div className="chat-banner error">
          <span>
            会话保存失败：{saveError}。新消息目前只存在内存中，请勿关闭应用。
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
          <span className="empty-state-icon"><Icon name="sliders" size={28} /></span>
          <h2>连接你的模型</h2>
          <p>配置模型服务和 API Key，开始在这个工作区中协作。</p>
          <button className="btn btn-primary" onClick={() => actions.openSettings()}>
            <Icon name="settings" /> 配置模型
          </button>
        </div>
      ) : messages.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon"><Icon name={office ? 'briefcase' : 'chat'} size={28} /></span>
          <span className="empty-state-eyebrow">{office ? t('你的 AI 办公助手') : project.name}</span>
          <h2>{office ? t('把资料变成工作成果') : t('今天一起完成什么？')}</h2>
          <p>{office ? t('整理文档、分析表格、制作演示文稿。添加资料或直接描述任务，生成可打开的办公文件。') : t('提问、排查问题或描述一个想法，助手会结合项目文件与你协作。')}</p>
          <div className="conversation-starters">
            {(office ? [t('生成一份 Word 项目周报模板'), t('制作一个 Excel 费用汇总表'), t('制作一份三页 PPT 工作总结')] : [t('介绍这个项目的结构'), t('检查代码中潜在的问题'), t('帮我规划下一步开发')]).map((prompt) => (
              <button key={prompt} className="btn btn-ghost" onClick={() => void actions.sendChat(prompt)}>{prompt}<Icon name="arrowUp" size={14} /></button>
            ))}
          </div>
        </div>
      ) : (
      <div className="message-list-wrap">
        <div className="message-list" ref={listRef} onScroll={onScroll}>
          <TodoPanel />
          {messages.map((m, idx) => (
              <div key={m.id} className={`message ${m.role}`}>
                <div className={`bubble ${m.role === 'assistant' ? 'md' : ''}`}>
                  {m.role === 'user' ? (
                    // 用户消息只含文本块
                    m.blocks
                      .filter((b) => b.type === 'text')
                      .map((b) => b.text)
                      .join('\n')
                  ) : m.blocks.length === 0 ? (
                    m.streaming ? <span className="thinking">{statusText || t('思考中…')}</span> : null
                  ) : (
                    m.blocks.map((b, i) => {
                      if (b.type === 'reasoning') {
                        return (
                          <details key={i} className="reasoning-collapse">
                            <summary><Icon name="brain" size={14} /> 思考过程</summary>
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
                  {!m.streaming && idx < messages.length - 1 ? (
                    <div className="msg-rewind">
                      <button
                        className="msg-rewind-btn"
                        title={`删除这条之后的 ${messages.length - idx - 1} 条消息，回退到这里`}
                        onClick={() => void actions.rewindToMessage(m.id)}
                      >
                        ⏪ {t('回到这里')}
                      </button>
                      <button
                        className="msg-rewind-btn"
                        title="复制这条及之前的消息为一个新会话（原会话不变）"
                        onClick={() => void actions.forkFromMessage(m.id)}
                      >
                        🍴 {t('从这里分叉')}
                      </button>
                    </div>
                  ) : (
                    !m.streaming ? (
                      <div className="msg-rewind">
                        <button
                          className="msg-rewind-btn"
                          title="复制全部消息为一个新会话（原会话不变）"
                          onClick={() => void actions.forkFromMessage(m.id)}
                        >
                          🍴 {t('从这里分叉')}
                        </button>
                      </div>
                    ) : null
                  )}
                </div>
              </div>
            ))}
          </div>
          {showJumpButton ? (
            <button className="jump-bottom" title={t('滚到最下面')} onClick={jumpToBottom}>
              <Icon name="arrowDown" />
            </button>
          ) : null}
        </div>
      )}

      <Composer disabled={streaming} attachments={office ? attachments : []} onAttach={office ? () => void importFiles() : undefined} onRemove={(path) => setAttachments((files) => files.filter((f) => f.path !== path))} onSend={office ? sendOffice : undefined} taskDraft={office ? taskDraft : null} />
    </main>
    {office && (
          <OfficePanel
            collapsed={preferences.officePanelCollapsed === true}
            onToggleCollapsed={() => void actions.setPreferences({ officePanelCollapsed: !(preferences.officePanelCollapsed === true) })}
            onImport={() => void importFiles()}
            onTask={(text) => setTaskDraft((previous) => ({ id: (previous?.id ?? 0) + 1, text }))}
            refreshKey={fileRefresh}
          />
        )}
        {!office && (
          <FileExplorerPanel
            collapsed={preferences.filesPanelCollapsed === true}
            onToggleCollapsed={() => void actions.setPreferences({ filesPanelCollapsed: !(preferences.filesPanelCollapsed === true) })}
          />
        )}
    </div>
  )
}
