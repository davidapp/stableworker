import { useEffect, useId, useRef, useState } from 'react'
import { useApp } from '../store'
import * as actions from '../actions'
import { LlmConfigPage } from './settings/LlmConfigPage'
import { PricingPage } from './settings/PricingPage'
import { ToolSwitchesPage } from './settings/ToolSwitchesPage'
import { RulesPage } from './settings/RulesPage'
import { SkillsPage } from './settings/SkillsPage'
import { McpPage } from './settings/McpPage'
import { SubagentTypesPage } from './settings/SubagentTypesPage'
import { HooksPage } from './settings/HooksPage'
import { MemoryPage } from './settings/MemoryPage'
import { Icon } from './Icon'
import { t } from '../i18n'

/**
 * 统一设置对话框：左侧导航 + 右侧页面。
 * 未来新增功能时，在 PAGES 里加一项并实现对应页面组件即可；
 */
const PAGES = [
  { id: 'llm', label: 'LLM 配置', icon: 'brain' },
  { id: 'pricing', label: '模型价格', icon: 'list' },
  { id: 'tools', label: '工具开关', icon: 'sliders' },
  { id: 'rules', label: '权限规则', icon: 'shield' },
  { id: 'skills', label: '斜杠命令', icon: 'terminal' },
  { id: 'mcp', label: 'MCP 服务器', icon: 'server' },
  { id: 'subagents', label: '子代理类型', icon: 'code' },
  { id: 'hooks', label: 'Hooks', icon: 'terminal' },
  { id: 'memory', label: '记忆', icon: 'brain' },
] as const

export function SettingsDialog() {
  const { settingsPage } = useApp()
  const [active, setActive] = useState<string>(settingsPage || 'llm')
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus()

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        actions.closeSettings()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'),
      ).filter((control) => control.getClientRects().length > 0)
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return (
    <div className="modal-overlay" onClick={() => actions.closeSettings()}>
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="settings-nav">
          <div className="settings-nav-header">
            <Icon name="settings" size={18} />
            <span className="settings-nav-title" id={titleId}>{t('设置')}</span>
          </div>
          <p className="settings-nav-subtitle" id={descriptionId}>模型、工具与工作区偏好</p>
          <nav className="settings-nav-list" aria-label="设置分类">
            {PAGES.map((p) => (
              <button
                key={p.id}
                className={`settings-nav-item ${active === p.id ? 'active' : ''}`}
                aria-current={active === p.id ? 'page' : undefined}
                onClick={() => setActive(p.id)}
              >
                <Icon name={p.icon} size={16} />
                {t(p.label)}
              </button>
            ))}
          </nav>
          <div className="spacer" />
          <div className="settings-nav-footer">StableWorker</div>
        </aside>

        <section className="settings-content">
          <div className="settings-content-header">
            <span>{t('偏好设置')}</span>
            <button className="icon-btn" aria-label="关闭设置" title="关闭设置 (Esc)" onClick={() => actions.closeSettings()}>
              <Icon name="close" size={18} />
            </button>
          </div>
          {/* 各页面保持挂载，切换导航不丢失未保存的编辑 */}
          <div hidden={active !== 'llm'}>
            <LlmConfigPage />
          </div>
          <div hidden={active !== 'pricing'}>
            <PricingPage />
          </div>
          <div hidden={active !== 'tools'}>
            <ToolSwitchesPage />
          </div>
          <div hidden={active !== 'rules'}>
            <RulesPage />
          </div>
          <div hidden={active !== 'skills'}>
            <SkillsPage />
          </div>
          <div hidden={active !== 'mcp'}>
            <McpPage />
          </div>
          <div hidden={active !== 'subagents'}>
            <SubagentTypesPage />
          </div>
          <div hidden={active !== 'hooks'}>
            <HooksPage />
          </div>
          <div hidden={active !== 'memory'}>
            <MemoryPage />
          </div>
        </section>
      </div>
    </div>
  )
}
