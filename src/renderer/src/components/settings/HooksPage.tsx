import { useState } from 'react'
import { useApp } from '../../store'
import type { HookConfig } from '../../../../shared/types'
import * as actions from '../../actions'

interface Draft {
  id: string
  event: HookConfig['event']
  matcher: string
  command: string
  timeoutText: string
  disabled: boolean
}

const EVENT_LABEL: Record<HookConfig['event'], string> = {
  preToolUse: '执行前（可阻止/改参/免批准）',
  postToolUse: '执行后（可追加上下文）',
  stop: '对话结束（副作用）',
}

const EXAMPLES: Record<HookConfig['event'], string> = {
  preToolUse: 'node check-tool.js',
  postToolUse: 'node log-tool.js',
  stop: 'node notify-done.js',
}

/** Hooks 页：管理生命周期钩子（stdin JSON + 退出码/stdout JSON 协议，对齐 Claude Code command 类型） */
export function HooksPage() {
  const { hooks } = useApp()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [notice, setNotice] = useState('')

  const persist = async (list: HookConfig[]): Promise<void> => {
    setNotice('')
    await window.api.setHooks(list)
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    const command = draft.command.trim()
    if (!command) {
      setNotice('❌ 命令行不能为空')
      return
    }
    const timeout = Number.parseInt(draft.timeoutText, 10)
    const entry: HookConfig = {
      id: draft.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      event: draft.event,
      matcher: draft.matcher.trim(),
      command,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
      disabled: draft.disabled,
    }
    const list = draft.id
      ? (hooks ?? []).map((h) => (h.id === draft.id ? entry : h))
      : [...(hooks ?? []), entry]
    setDraft(null)
    await persist(list)
    setNotice('✅ 已保存（下一轮对话生效）')
  }

  const toggleDisabled = async (h: HookConfig): Promise<void> => {
    await persist((hooks ?? []).map((x) => (x.id === h.id ? { ...x, disabled: !x.disabled } : x)))
  }

  const remove = async (h: HookConfig): Promise<void> => {
    if (!(await actions.confirm(`删除该 ${EVENT_LABEL[h.event]} 钩子？`))) return
    await persist((hooks ?? []).filter((x) => x.id !== h.id))
  }

  const editDraft = (h: HookConfig): Draft => ({
    id: h.id,
    event: h.event,
    matcher: h.matcher,
    command: h.command,
    timeoutText: h.timeoutMs ? String(h.timeoutMs) : '',
    disabled: h.disabled ?? false,
  })

  return (
    <div className="settings-page">
      <h2>Hooks</h2>
      <p className="hint-line">
        生命周期钩子：在工具执行前 / 后、对话结束时运行本地命令（对齐 Claude Code 的 command 类型）。
        命令经 stdin 收到 JSON（<code className="tool-switch-name">{'{ sessionId, toolName, toolInput, toolResult }'}</code>）；
        <code className="tool-switch-name">preToolUse</code> 退出码 2 或输出{' '}
        <code className="tool-switch-name">{'{ "decision": "block", "reason": "…" }'}</code> 阻止执行，
        输出 <code className="tool-switch-name">{'{ "decision": "approve" }'}</code> 跳过批准、
        <code className="tool-switch-name">{'{ "updatedInput": {…} }'}</code> 改写入参；
        <code className="tool-switch-name">postToolUse</code> 输出{' '}
        <code className="tool-switch-name">{'{ "additionalContext": "…" }'}</code> 追加给模型。
        命令崩溃/超时按跳过处理，不阻塞工具。
      </p>

      {draft ? (
        <>
          <div className="field">
            <span>触发时机</span>
            <div className="settings-radio-group">
              {(Object.keys(EVENT_LABEL) as HookConfig['event'][]).map((ev) => (
                <label key={ev}>
                  <input
                    type="radio"
                    name="hook-event"
                    checked={draft.event === ev}
                    onChange={() => setDraft({ ...draft, event: ev })}
                  />
                  {ev}
                </label>
              ))}
            </div>
          </div>
          {draft.event !== 'stop' ? (
            <div className="field">
              <span>工具名匹配器（空 = 全部工具；精确名或前缀通配，如 run_command*）</span>
              <input
                value={draft.matcher}
                placeholder="例如 run_command"
                onChange={(e) => setDraft({ ...draft, matcher: e.target.value })}
              />
            </div>
          ) : null}
          <div className="field">
            <span>命令行（不经 shell 直接执行；stdin 收 JSON）</span>
            <input
              value={draft.command}
              placeholder={EXAMPLES[draft.event]}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
          </div>
          <div className="field">
            <span>超时毫秒（默认 10000）</span>
            <input
              value={draft.timeoutText}
              placeholder="10000"
              onChange={(e) => setDraft({ ...draft, timeoutText: e.target.value })}
            />
          </div>
          <div className="settings-page-actions">
            <button className="btn" onClick={() => setDraft(null)}>
              取消
            </button>
            <div className="spacer" />
            <button className="btn btn-primary" onClick={() => void saveDraft()}>
              保存
            </button>
          </div>
        </>
      ) : (
        <>
          {(hooks ?? []).length === 0 ? (
            <div className="profile-empty">还没有配置钩子。点下面"＋ 新增钩子"创建。</div>
          ) : (
            <div className="profile-list">
              {(hooks ?? []).map((h) => (
                <div className="profile-row" key={h.id}>
                  <div className="profile-info">
                    <span className="profile-name">
                      <code className="tool-switch-name">{h.event}</code>
                      <span className="saved-hint" style={{ marginLeft: 8 }}>
                        {h.event === 'stop' ? '全部' : h.matcher || '全部工具'}
                        {h.disabled ? ' · ⏸ 已停用' : ''}
                      </span>
                    </span>
                    <small>{h.command}</small>
                  </div>
                  <div className="profile-actions">
                    <button className="btn" onClick={() => void toggleDisabled(h)}>
                      {h.disabled ? '启用' : '停用'}
                    </button>
                    <button className="btn" onClick={() => setDraft(editDraft(h))}>
                      编辑
                    </button>
                    <button className="btn btn-danger-ghost" onClick={() => void remove(h)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="settings-page-actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                setDraft({ id: '', event: 'preToolUse', matcher: '', command: '', timeoutText: '', disabled: false })
              }
            >
              ＋ 新增钩子
            </button>
            <div className="spacer" />
            {notice ? <span className="saved-hint">{notice}</span> : null}
          </div>
        </>
      )}
    </div>
  )
}
