import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { BalanceResult, ChatMessage, ContextInfo } from '../../../shared/types'
import { copyText } from '../clipboard'
import { Icon } from './Icon'

/**
 * 上下文管理窗口（独立悬浮窗，?page=context）：
 * 左侧滚动消息列表（可勾选），右侧选中消息的详情编辑。
 * 勾选两条以上可把该范围压缩成一条摘要消息（整段替换，安全保持配对）。
 */

const fmtTs = (ts: number): string => new Date(ts).toLocaleString()

function clampListWidth(width: number): number {
  // 为详情保留至少 300px，并预留 5px 分隔条。
  const maxWidth = Math.max(240, Math.min(560, window.innerWidth - 305))
  return Math.min(maxWidth, Math.max(240, width))
}

function roleLabel(role: string): string {
  return role === 'user' ? '用户' : role === 'assistant' ? '助手' : role
}

function textOf(m: ChatMessage): string {
  return m.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n')
}

function preview(m: ChatMessage): string {
  const tools = m.blocks.filter((b) => b.type === 'tool_use')
  const base = textOf(m).replace(/\s+/g, ' ').trim()
  if (base) return base.slice(0, 60)
  if (tools.length) return `[${tools.map((b) => (b as { name?: string }).name).join(', ')}]`
  return '（空）'
}

export function ContextWindow() {
  const [target, setTarget] = useState<{ projectId: string; sessionId: string; title: string } | null>(null)
  const [listWidth, setListWidth] = useState(() => clampListWidth(340))
  const draggingRef = useRef(false)
  const [missing, setMissing] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const [balance, setBalance] = useState<BalanceResult | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [editText, setEditText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [sumText, setSumText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  // 左栏宽度拖拽（240–560px），随窗口宽度限制，保留详情的可用空间。
  const onSplitterDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }
  const onSplitterMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    setListWidth(clampListWidth(e.clientX))
  }
  const onSplitterUp = (): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }

  useEffect(() => {
    const onResize = (): void => setListWidth(clampListWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const refresh = useCallback(async () => {
    if (!target) return
    const i = await window.api.getContextInfo(target.projectId, target.sessionId)
    setInfo(i)
    const s = await window.api.loadSession(target.projectId, target.sessionId)
    setMessages(s?.session?.messages ?? [])
    setSumText(s?.session?.summary?.text ?? '')
  }, [target])

  useEffect(() => {
    void window.api.getCurrentSession().then((t) => {
      if (t) setTarget(t)
      else setMissing(true)
    })
  }, [])

  useEffect(() => {
    void refresh()
    setChecked(new Set())
    setSelectedId(null)
    setDirty(false)
  }, [refresh])

  const selectedIndex = messages.findIndex((m) => m.id === selectedId)
  const selected = selectedIndex >= 0 ? messages[selectedIndex] : null

  const select = (id: string): void => {
    if (dirty) {
      if (!window.confirm('当前编辑未保存，放弃修改？')) return
    }
    setSelectedId(id)
    const m = messages.find((x) => x.id === id)
    setEditText(m ? textOf(m) : '')
    setDirty(false)
    setDirty(false)
  }

  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(name)
    try {
      await fn()
      await refresh()
      setNotice(`${name}完成`)
    } catch (err) {
      setNotice(`失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const saveEdit = (): void => {
    if (!target || !selected) return
    void run('保存编辑', async () => {
      const ok = await window.api.editMessage(target.projectId, target.sessionId, selected.id, editText)
      if (!ok) throw new Error('保存失败（会话可能已被删除）')
      setDirty(false)
    })
  }

  const deleteSelected = (): void => {
    if (!target || !selected) return
    if (!window.confirm(`确定删除第 ${selectedIndex + 1} 条消息？内容不可恢复。`)) return
    void run('删除消息', async () => {
      const ok = await window.api.deleteMessage(target.projectId, target.sessionId, selected.id)
      if (!ok) throw new Error('删除失败')
      setSelectedId(null)
      setEditText('')
    })
  }

  const toggleCheck = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const compressChecked = (): void => {
    if (!target || checked.size === 0) return
    const ids = messages.filter((m) => checked.has(m.id)).map((m) => m.id)
    const firstIdx = messages.findIndex((m) => m.id === ids[0])
    const lastIdx = messages.findIndex((m) => m.id === ids[ids.length - 1])
    const n = lastIdx - firstIdx + 1
    if (
      !window.confirm(
        `将把第 ${firstIdx + 1}–${lastIdx + 1} 条（共 ${n} 条）压缩为一条摘要消息。\n` +
          '该范围会整体替换（保持工具调用配对完整），不可恢复。继续？',
      )
    ) {
      return
    }
    void run('压缩所选', async () => {
      const r = await window.api.compressRange(target.projectId, target.sessionId, ids[0], ids[ids.length - 1])
      if (!r.ok) throw new Error(r.error ?? '压缩失败')
      setChecked(new Set())
      setSelectedId(null)
    })
  }

  const saveSummary = (): void => {
    if (!target) return
    void run('保存摘要', async () => {
      const r = await window.api.saveContextSummary(target.projectId, target.sessionId, sumText)
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

  const compactAll = (): void => {
    if (!target || messages.length === 0) return
    if (!window.confirm('把当前全部对话压缩成一份摘要？界面保留，之后请求只发摘要。')) return
    void run('压缩全部对话', async () => {
      const r = await window.api.compactNow(target.projectId, target.sessionId)
      if (!r.ok) throw new Error(r.error ?? '压缩失败')
      setSumText(r.summaryText ?? '')
    })
  }

  const clearAll = (): void => {
    if (!target) return
    if (!window.confirm('确定清空当前会话的全部消息？摘要也会作废，不可恢复。')) return
    void run('清空上下文', async () => {
      const ok = await window.api.clearSessionContextById(target.projectId, target.sessionId)
      if (!ok) throw new Error('清空失败')
      setSelectedId(null)
      setEditText('')
      setDirty(false)
    })
  }

  const exportMarkdown = async (): Promise<void> => {
    if (!target) return
    await run('导出会话', async () => {
      const saved = await window.api.exportMarkdown(target.projectId, target.sessionId)
      if (!saved.ok) throw new Error(saved.error ?? '导出失败')
      setNotice('已导出到：' + saved.path)
    })
  }

  const queryBalance = async (): Promise<void> => {
    await run('查询余额', async () => {
      setBalance(await window.api.queryBalance())
    })
  }

  if (missing) {
    return (
      <div className="utility-window ctx-window">
        <header className="utility-header">
          <div className="utility-brand"><Icon name="logo" size={18} /><span>StableWorker</span></div>
          <div className="utility-heading"><h2 className="utility-title">上下文管理</h2><span className="utility-subtitle">管理会话消息与摘要</span></div>
        </header>
        <div className="inspector-empty"><Icon name="chat" size={24} /><span>当前没有打开的会话。先在主窗口选择一个项目和会话，再打开本窗口。</span></div>
      </div>
    )
  }

  return (
    <div className="utility-window ctx-window">
      <header className="utility-header">
        <div className="utility-brand"><Icon name="logo" size={18} /><span>StableWorker</span></div>
        <div className="utility-heading">
          <h2 className="utility-title">上下文管理</h2>
          <span className="utility-subtitle">
            {target?.title ?? '…'} · {info ? `${info.messageCount} 条消息 · ≈${info.tokensEstimate.toLocaleString()} tokens` : ''}
          </span>
        </div>
        <div className="utility-actions">
          <button className="btn" onClick={() => void refresh()}>
            <Icon name="refresh" />
            刷新
          </button>
        </div>
      </header>

      <div className="ctx-split">
        {/* 左侧：滚动消息列表（可勾选做范围压缩） */}
        <aside className="ctx-list" style={{ width: listWidth }}>
          <div className="ctx-list-head">
            <span>消息列表（{messages.length} 条）</span>
            <button
              className="btn"
              disabled={checked.size === 0 || busy !== null}
              title={checked.size < 2 ? '勾选两条以上可压缩该范围' : '把勾选范围压缩为一条摘要'}
              onClick={compressChecked}
            >
              <Icon name="brain" />
              压缩所选{checked.size > 0 ? `（${checked.size} 条）` : ''}
            </button>
          </div>
          {messages.map((m, idx) => {
            const isSel = m.id === selectedId
            const isEditing = selected?.id === m.id && dirty
            return (
              <div
                key={m.id}
                className={`ctx-list-item ${isSel ? 'selected' : ''} ${isEditing ? 'editing' : ''}`}
                onClick={() => select(m.id)}
              >
                <input
                  type="checkbox"
                  title="勾选用于范围压缩"
                  checked={checked.has(m.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleCheck(m.id)}
                />
                <div className="ctx-list-texts">
                  <div className="ctx-list-role">
                    {roleLabel(m.role)} · 第 {idx + 1} 条
                    {m.blocks.some((b) => b.type === 'tool_use') ? <Icon name="code" size={12} className="ctx-inline-icon" /> : null}
                  </div>
                  <div className="ctx-list-preview">{preview(m)}</div>
                </div>
              </div>
            )
          })}
          {messages.length === 0 ? <div className="inspector-empty">会话没有消息。</div> : null}
        </aside>

        {/* 中间分隔条：拖拽调整左栏宽度 */}
        <div
          className="ctx-vsplit"
          title="拖拽调整列表宽度"
          onPointerDown={onSplitterDown}
          onPointerMove={onSplitterMove}
          onPointerUp={onSplitterUp}
        />

        {/* 右侧：详情 / 编辑 */}
        <section className="ctx-detail">
          {!selected ? (
            <>
              <div className="ctx-title-row">
                <span>摘要压缩记录</span>
                <span className="ctx-value">
                  {info?.summary ? `覆盖前 ${info.summary.droppedCount} 条 · ${fmtTs(info.summary.ts)}` : '无'}
                </span>
              </div>
              <textarea
                className="holidays-input ctx-summary-input"
                rows={10}
                value={sumText}
                placeholder={'选中左侧消息可查看 / 编辑 / 删除。\n摘要压缩记录也会显示在这里，可手写或删除。'}
                onChange={(e) => setSumText(e.target.value)}
              />
              <div className="ctx-btn-row">
                <button className="btn btn-primary" disabled={!sumText.trim()} onClick={saveSummary}>
                  <Icon name="check" />
                  保存摘要
                </button>
                <button className="btn btn-danger-ghost" disabled={!info?.summary} onClick={deleteSummary}>
                  <Icon name="trash" />
                  删除摘要
                </button>
                <div className="spacer" />
                <button className="btn" disabled={messages.length === 0} onClick={compactAll}>
                  <Icon name="brain" />
                  压缩全部对话
                </button>
                <button className="btn" disabled={messages.length === 0} title="导出会话为 Markdown 文件" onClick={() => void exportMarkdown()}>
                  <Icon name="download" />
                  导出
                </button>
                <button className="btn btn-danger-ghost" disabled={messages.length === 0} onClick={clearAll}>
                  <Icon name="trash" />
                  清空上下文
                </button>
              </div>
              <div className="hint-line">
                提示：在左侧勾选两条以上消息，可把该范围压缩成一条摘要消息（整段替换，保持工具调用配对）。
              </div>

              <div className="ctx-title-row ctx-section-spaced">
                <span>API Key 余额</span>
                <button className="btn" disabled={busy !== null} onClick={() => void queryBalance()}>
                  <Icon name="key" />
                  {busy === '查询余额' ? '查询中…' : '查询'}
                </button>
              </div>
              {balance ? (
                <div className={`ctx-value ctx-balance result-status ${balance.ok ? 'success' : 'error'}`} role="status">
                  <Icon name={balance.ok ? 'check' : 'warning'} />
                  {balance.ok
                    ? `可用：${balance.currency === 'USD' ? '$' : balance.currency === 'CNY' ? '¥' : ''}${balance.totalBalance ?? '?'}${balance.currency === 'CNY' ? '（人民币）' : ''}${balance.grantedBalance && balance.grantedBalance !== '0' ? ` · 赠送 ${balance.grantedBalance}` : ''}${balance.isAvailable === false ? ' · 账户不可用' : ''}`
                    : balance.error ?? '查询失败'}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="ctx-title-row">
                <span className="ctx-detail-title">
                  {roleLabel(selected.role)} · 第 {selectedIndex + 1} 条
                  {selected.blocks.some((b) => b.type === 'tool_use') ? <span className="ctx-inline-icon"><Icon name="code" size={12} /> 含工具调用</span> : null}
                </span>
                <span className="ctx-value">{fmtTs(selected.createdAt)}</span>
              </div>
              <textarea
                className="holidays-input ctx-edit"
                rows={16}
                value={editText}
                onChange={(e) => {
                  setEditText(e.target.value)
                  setDirty(true)
                }}
              />
              <div className="ctx-md-preview">
                <div className="ctx-title-row">
                  <span>渲染预览</span>
                </div>
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {editText}
                </ReactMarkdown>
              </div>
              <div className="ctx-btn-row">
                <button className="btn btn-primary" disabled={!dirty} onClick={saveEdit}>
                  <Icon name="check" />
                  保存修改
                </button>
                <button className="btn" disabled={!dirty} onClick={() => select(selected.id)}>
                  <Icon name="close" />
                  放弃修改
                </button>
                <div className="spacer" />
                <button className="btn" onClick={() => void copyText(editText)}>
                  <Icon name="copy" />
                  复制
                </button>
                <button className="btn btn-danger-ghost" onClick={deleteSelected}>
                  <Icon name="trash" />
                  删除此消息
                </button>
              </div>
              {selected.blocks.some((b) => b.type === 'tool_use') ? (
                <div className="hint-line result-status">
                  <Icon name="warning" />
                  此消息包含工具调用（编辑仅改文本部分，工具调用与其结果原样保留）。
                </div>
              ) : null}
            </>
          )}

          {notice ? <div className={`ctx-panel-notice result-status ${notice.startsWith('失败：') ? 'error' : 'success'}`} role="status"><Icon name={notice.startsWith('失败：') ? 'warning' : 'check'} />{notice}</div> : null}
        </section>
      </div>
    </div>
  )
}
