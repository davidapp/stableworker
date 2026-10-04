import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../../store'
import * as actions from '../../actions'

interface ToolMeta {
  name: string
  description: string
  requiresApproval: boolean
  kind: string | undefined
}

const KIND_LABEL: Record<string, string> = {
  read: '只读',
  edit: '文件编辑',
  system: '系统',
}

/** 工具开关页：控制哪些工具随请求发给模型（禁用 = 模型不知道它的存在） */
export function ToolSwitchesPage() {
  const { toolSwitches } = useApp()
  const [tools, setTools] = useState<ToolMeta[]>([])
  const [saved, setSaved] = useState(false)

  const refresh = useCallback((): void => {
    void window.api.listTools().then(setTools)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    await actions.setToolSwitch(name, enabled)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const isEnabled = (name: string): boolean => toolSwitches[name] !== false
  const enabledCount = tools.filter((t) => isEnabled(t.name)).length

  return (
    <div className="settings-page">
      <h2>工具开关</h2>
      <p className="hint-line">
        控制哪些工具随请求发给模型：被禁用的工具不会出现在 tools 列表里，模型不会调用它。
        当前启用 {enabledCount} / {tools.length} 个。
      </p>

      {tools.map((t) => (
        <div className="features-row" key={t.name}>
          <label className="features-text">
            <span className="features-label">
              <code className="tool-switch-name">{t.name}</code>
              {t.requiresApproval ? <span className="badge">需批准</span> : null}
              {t.kind ? <span className="badge">{KIND_LABEL[t.kind] ?? t.kind}</span> : null}
            </span>
            <small>{t.description}</small>
          </label>
          <label className="features-toggle">
            <input
              type="checkbox"
              checked={isEnabled(t.name)}
              onChange={(e) => void toggle(t.name, e.target.checked)}
            />
            启用
          </label>
        </div>
      ))}

      <div className="settings-page-actions">
        <div className="spacer" />
        {saved ? <span className="saved-hint">✅ 已保存，下一轮对话生效</span> : null}
      </div>
    </div>
  )
}
