import { useEffect, useState } from 'react'
import type { ContextInfo } from '../../../shared/types'
import { useApp } from '../store'
import * as actions from '../actions'

/**
 * 上下文管理面板（聊天右上角 📚 按钮弹出）：
 * 浏览消息数 / token 占用，浏览 / 编辑 / 删除摘要，手动压缩，清空上下文。
 */
export function ContextManagePanel() {
  const { activeProjectId, activeSessionId } = useApp()
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  const refresh = async (): Promise<void> => {
    if (!activeProjectId || !activeSessionId) return
    const i = await window.api.getContextInfo(activeProjectId, activeSessionId)
    setInfo(i)
    setText(i.summary?.text ?? '')
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeSessionId])

  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(name)
    try {
      await fn()
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const saveSummary = (): void =>
    void run('save', async () => {
      const r = await window.api.saveContextSummary(activeProjectId ?? '', activeSessionId ?? '', text)
      setNotice(r.ok ? '✅ 摘要已保存' : `❌ ${r.error ?? '保存失败'}`)
    })

  const deleteSummary = (): void =>
    void run('del', async () => {
      const r = await window.api.deleteContextSummary(activeProjectId ?? '', activeSessionId ?? '')
      setNotice(r.ok ? '✅ 摘要已删除' : `❌ ${r.error ?? '删除失败'}`)
    })

  const compactNow = (): void =>
    void run('compact', async () => {
      const r = await window.api.compactNow(activeProjectId ?? '', activeSessionId ?? '')
      if (r.ok) {
        setNotice(`✅ 已压缩 ${r.droppedCount} 条消息为摘要，下一条消息起生效`)
      } else {
        setNotice(`❌ ${r.error ?? '压缩失败'}`)
      }
    })

  const clearContext = (): void => {
    if (window.confirm('确定清空当前会话的上下文吗？消息将从会话中移除且不可恢复（摘要也会作废）。')) {
      void actions.clearSessionContext()
      setNotice('✅ 上下文已清空')
    }
  }

  const hasSummary = Boolean(info?.summary?.text)

  return (
    <div className="mode-menu-wrap">
      <button
        className="btn"
        title="上下文管理：摘要 / 压缩 / 清空"
        disabled={!activeSessionId}
        onClick={() => setOpen((v) => !v)}
      >
        📚 上下文
      </button>

      {open ? (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="ctx-panel">
            <div className="ctx-panel-section">
              <div className="ctx-title-row">
                <span>当前会话</span>
                <span className="ctx-value">
                  {info ? `${info.messageCount} 条消息 · ≈${info.tokensEstimate.toLocaleString()} tokens` : '…'}
                </span>
              </div>
            </div>

            <div className="ctx-panel-section">
              <div className="ctx-title-row">
                <span>摘要压缩记录</span>
                <span className="ctx-value">
                  {info?.summary ? `覆盖前 ${info.summary.droppedCount} 条` : '无'}
                </span>
              </div>
              <textarea
                className="holidays-input"
                rows={6}
                value={text}
                placeholder={hasSummary ? '' : '暂无摘要。点"压缩全部对话"自动生成，或在此手写一份摘要后保存。'}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="ctx-btn-row">
                <button className="btn" disabled={busy !== null || !text.trim()} onClick={() => saveSummary()}>
                  {busy === 'save' ? '保存中…' : '保存摘要'}
                </button>
                <button
                  className="btn"
                  disabled={busy !== null || !hasSummary}
                  title="删除摘要（模型将不再记得被折叠的内容）"
                  onClick={() => deleteSummary()}
                >
                  {busy === 'del' ? '删除中…' : '删除摘要'}
                </button>
              </div>
            </div>

            <div className="ctx-panel-section">
              <div className="ctx-title-row">
                <span>操作</span>
              </div>
              <div className="ctx-btn-row">
                <button
                  className="btn"
                  disabled={busy !== null || !info || info.messageCount === 0}
                  title="把当前全部对话压缩成一份摘要；界面保留，之后请求只发摘要"
                  onClick={() => compactNow()}
                >
                  {busy === 'compact' ? '压缩中…' : '⚡ 压缩全部对话'}
                </button>
                <button
                  className="btn"
                  disabled={busy !== null || !activeSessionId}
                  title="清空消息历史（不可恢复）"
                  onClick={clearContext}
                >
                  🧹 清空上下文
                </button>
              </div>
            </div>

            {notice ? <div className="ctx-panel-notice">{notice}</div> : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
