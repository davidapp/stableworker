import { useState } from 'react'
import { useApp } from '../store'
import * as actions from '../actions'
import { LlmConfigPage } from './settings/LlmConfigPage'
import { PricingPage } from './settings/PricingPage'
import { FeaturesPage } from './settings/FeaturesPage'

/**
 * 统一设置对话框：左侧导航 + 右侧页面。
 * 未来新增功能时，在 PAGES 里加一项并实现对应页面组件即可；
 * 功能入口的显隐由"功能开关"页统一管理（见 src/renderer/src/features.ts）。
 */
const PAGES = [
  { id: 'llm', label: 'LLM 配置' },
  { id: 'pricing', label: '模型价格' },
  { id: 'features', label: '功能开关' },
] as const

export function SettingsDialog() {
  const { settingsPage } = useApp()
  const [active, setActive] = useState<string>(settingsPage || 'llm')

  return (
    <div className="modal-overlay" onClick={() => actions.closeSettings()}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={`settings-nav-item ${active === p.id ? 'active' : ''}`}
              onClick={() => setActive(p.id)}
            >
              {p.label}
            </button>
          ))}
          <div className="spacer" />
          <button className="btn" onClick={() => actions.closeSettings()}>
            关闭
          </button>
        </aside>

        <section className="settings-content">
          {/* 三个页面保持挂载，切换导航不丢失未保存的编辑 */}
          <div style={{ display: active === 'llm' ? 'block' : 'none' }}>
            <LlmConfigPage />
          </div>
          <div style={{ display: active === 'pricing' ? 'block' : 'none' }}>
            <PricingPage />
          </div>
          <div style={{ display: active === 'features' ? 'block' : 'none' }}>
            <FeaturesPage />
          </div>
        </section>
      </div>
    </div>
  )
}
