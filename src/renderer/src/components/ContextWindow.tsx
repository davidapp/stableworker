import { useCallback, useEffect, useState } from 'react'
import type { ChatMessage, ContextInfo } from '../../../shared/types'
import { copyText } from '../clipboard'

/**
 * 上下文管理窗口（独立悬浮窗，?page=context）：
 * 逐条浏览 / 编辑 / 删除会话消息，管理摘要压缩，清空上下文。
 * 操作直接写会话 JSONL，主窗口的聊天界面在下次打开该会话时反映变更。
 */

const fmtTs = (ts: number): string => new Date(ts).toLocaleString()

function roleLabel(role: string): string {
  return role === 'user' ? '用户' : role === 'assistant' ? '助手' : role
}

export function ContextWindow() {
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [notice, setNotice] = useState('')
  const [missing, setMissing] = useState(false)
  const [text, setText] = useState('')

  // 上下文管理窗口没有"当前项目/会话"状态，读取主窗口最近使用的会话：
  // 由 preload 在窗口创建时通过主进程提供的全局最近会话决定（见 sessions:current）
  const [target, setTarget] = useState<{ projectId: string; sessionId: string; title: string } | null>(null)

  const refresh = useCallback(async () => {
    if (!target) return
    const i = await window.api.getContextInfo(target.projectId, target.sessionId)
    setInfo(i)
    const s = await window.api.loadSession(target.projectId, target.sessionId)
    setMessages(s?.session?.messages ?? [])
  }, [target])

  useEffect(() => {
    void window.api.getCurrentSession().then((t) => {
      if (t) setTarget(t)
      else setMissing(true)
    })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      await refresh()
      setNotice(`✅ ${name}完成`)
    } catch (err) {
      setNotice(`❌ ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const saveEdit = (): void => {
    if (!editing || !target) return
    void run('保存编辑', async () => {
      const ok = await window.api.editMessage(target.projectId, target.sessionId, editing.id, editing.text)
      if (!ok) throw new Error('保存失败（会话可能已被删除）')
    })
    setEditing(null)
  }

  const deleteOne = (id: string): void => {
    if (!target) return
    if (!window.confirm('确定删除这条消息？内容不可恢复。')) return
    void run('删除消息', async () => {
      const ok = await window.api.deleteMessage(target.projectId, target.sessionId, id)
      if (!ok) throw new Error('删除失败（会话可能已被删除）')
    })
  }

  const saveSummary = (): void => {
    if (!target) return
    void run('保存摘要', async () => {
      const r = await window.api.saveContextSummary(target.projectId, target.sessionId, text)
      if (!r.ok) throw new Error(r.error ?? '保存失败')
    })
  }

  const deleteSummary = (): void => {
    if (!target) return
    void run('删除摘要', async () => {
      const r = await window.api.deleteContextSummary(target.projectId, target.sessionId)
      if (!r.ok) throw new Error(r.error ?? '删除失败')
    })
  }

  const compactNow = (): void => {
    if (!target) return
    void run('压缩全部对话', async () => {
      const r = await window.api.compactNow(target.projectId, target.sessionId)
      if (!r.ok) throw new Error(r.error ?? '压缩失败')
      if (r.summaryText) setText(r.summaryText)
    })
  }

  const clearAll = (): void => {
    if (!target) return
    if (!window.confirm('确定清空当前会话的全部消息？摘要也会作废，不可恢复。')) return
    void run('清空上下文', async () => {
      const ok = await window.api.clearSessionContextById(target.projectId, target.sessionId)
      if (!ok) throw new Error('清空失败')
    })
  }

  if (missing) {
    return (
      <div className="ctx-window">
        <div className="inspector-empty">当前没有打开的会话。先在主窗口选择一个项目和会话，再打开本窗口。</div>
      </div>
    )
  }

  return (
    <div className="ctx-window">
      <header className="inspector-header">
        <h2>上下文管理</h2>
        <span className="hint">
          {target ? target.title : '…'} · {info ? `${info.messageCount} 条消息 · ≈${info.tokensEstimate.toLocaleString()} tokens` : ''}
        </span>
        <div className="spacer" />
        <button className="btn" onClick={() => void refresh()}>
          刷新
        </button>
      </header>

      <div className="ctx-window-body">
        <section className="ctx-panel-section">
          <div className="ctx-title-row">
            <span>消息列表（{messages.length} 条）</span>
            <span className="ctx-value">逐条编辑 / 删除；更改直接写入会话文件</span>
          </div>
          {messages.map((m, idx) =>
            editing?.id === m.id ? (
              <div key={m.id} className="ctx-msg editing">
                <div className="ctx-msg-head">
                  <span className="ctx-msg-role">{roleLabel(m.role)} · 第 {idx + 1} 条</span>
                </div>
                <textarea
                  className="holidays-input"
                  rows={Math.min(12, Math.max(3, editing.text.split('\n').length + 1))}
                  value={editing.text}
                  onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                />
                <div className="ctx-btn-row">
                  <button className="btn btn-primary" onClick={saveEdit}>
                    保存
                  </button>
                  <button className="btn" onClick={() => setEditing(null)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div key={m.id} className="ctx-msg">
                <div className="ctx-msg-head">
                  <span className="ctx-msg-role">
                    {roleLabel(m.role)} · 第 {idx + 1} 条
                  </span>
                  <span className="ctx-msg-tools">
                    {m.blocks
                      .filter((b) => b.type === 'tool_use')
                      .map((b) => (b as { name?: string }).name)
                      .join(', ')}
                  </span>
                  <div className="spacer" />
                  <button className="tool-copy-btn" title="复制这条消息的文本" onClick={() => void copyText(m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n'))}>
                    复制
                  </button>
                  <button className="tool-copy-btn" title="编辑这条消息" onClick={() => setEditing({ id: m.id, text: m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n') })}>
                    编辑
                  </button>
                  <button className="tool-copy-btn danger" title="删除这条消息" onClick={() => deleteOne(m.id)}>
                    删除
                  </button>
                </div>
                <pre className="ctx-msg-text">
                  {m.blocks
                    .filter((b) => b.type === 'text')
                    .map((b) => (b as { text: string }).text)
                    .join('\n') || (m.blocks.some((b) => b.type === 'tool_use') ? '（工具调用，见上方标签）' : '（空）')}
                </pre>
              </div>
            ),
          )}
          {messages.length === 0 ? <div className="inspector-empty">会话没有消息。</div> : null}
        </section>

        <section className="ctx-panel-section">
          <div className="ctx-title-row">
            <span>摘要压缩记录</span>
            <span className="ctx-value">{info?.summary ? `覆盖前 ${info.summary.droppedCount} 条 · ${fmtTs(info.summary.ts)}` : '无'}</span>
          </div>
          <textarea
            className="holidays-input"
            rows={6}
            value={text}
            placeholder={info?.summary ? '' : '暂无摘要。点"压缩全部对话"自动生成，或手写一份摘要后保存。'}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="ctx-btn-row">
            <button className="btn" disabled={!text.trim()} onClick={saveSummary}>
              保存摘要
            </button>
            <button className="btn" disabled={!info?.summary} onClick={deleteSummary}>
              删除摘要
            </button>
          </div>
        </section>

        <section className="ctx-panel-section">
          <div className="ctx-btn-row">
            <button
              className="btn"
              disabled={messages.length === 0}
              title="把当前全部对话压缩成一份摘要；界面保留，之后请求只发摘要"
              onClick={compactNow}
            >
              ⚡ 压缩全部对话
            </button>
            <button className="btn" disabled={messages.length === 0} onClick={clearAll}>
              🧹 清空上下文
            </button>
          </div>
        </section>

        {notice ? <div className="ctx-panel-notice">{notice}</div> : null}
      </div>
    </div>
  )
}
