import { useState } from 'react'
import { useApp } from '../store'
import * as actions from '../actions'
import type { ApprovalMode } from '../../../shared/types'
import { CaretIcon } from './CaretIcon'
import { Icon, type IconName } from './Icon'

/** 批准模式选项（对齐 Claude Code 的权限模式） */
const MODES: { id: ApprovalMode; icon: IconName; label: string; description: string }[] = [
  { id: 'plan', icon: 'list', label: '规划模式', description: '只读研究和制定计划。' },
  { id: 'confirm', icon: 'shield', label: '变更前确认', description: '改文件前先问我。' },
  { id: 'autoEdit', icon: 'edit', label: '自动编辑', description: '自动编辑文件。' },
  { id: 'fullAccess', icon: 'warning', label: '完全访问', description: '减少确认次数。' },
]

/** 输入框下方的批准模式选择器：决定危险工具执行前是否需要确认 */
export function ApprovalModeMenu() {
  const { approvalMode } = useApp()
  const [open, setOpen] = useState(false)
  const current = MODES.find((m) => m.id === approvalMode) ?? MODES[0]

  return (
    <div className="mode-menu-wrap">
      <button className="mode-btn" onClick={() => setOpen((v) => !v)} title="批准模式" aria-expanded={open}>
        <Icon name={current.icon} size={14} />
        <span>{current.label}</span>
        <CaretIcon />
      </button>

      {open ? (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="mode-menu">
            {MODES.map((m) => (
              <button
                key={m.id}
                className={`mode-item ${m.id === approvalMode ? 'active' : ''}`}
                onClick={() => {
                  void actions.setApprovalMode(m.id)
                  setOpen(false)
                }}
              >
                <Icon name={m.icon} />
                <span className="mode-texts">
                  <span className="mode-label">{m.label}</span>
                  <small>{m.description}</small>
                </span>
                {m.id === approvalMode ? <span className="mode-check">✓</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
