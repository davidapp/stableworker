import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../../store'
import { Icon } from '../Icon'
import * as actions from '../../actions'

interface ToolMeta {
  name: string
  description: string
  requiresApproval: boolean
  kind: string | undefined
}

type Mode = 'coding' | 'office' | 'video'

const KIND_LABEL: Record<string, string> = {
  read: '只读',
  edit: '文件编辑',
  system: '系统',
}

const MODE_LABEL: Record<Mode, string> = { coding: '编程', office: '办公', video: '视频' }

/** 工具开关页：Tab 区分编程 / 办公 / 视频模式，各自的开关独立保存（禁用 = 模型不知道该工具） */
export function ToolSwitchesPage() {
  const { toolSwitches, officeToolSwitches, videoToolSwitches } = useApp()
  const [lists, setLists] = useState<{ coding: ToolMeta[]; office: ToolMeta[]; video: ToolMeta[] }>({ coding: [], office: [], video: [] })
  const [mode, setMode] = useState<Mode>('coding')
  const [saved, setSaved] = useState(false)

  const refresh = useCallback((): void => {
    void Promise.all([window.api.listTools('coding'), window.api.listTools('office'), window.api.listTools('video')]).then(([coding, office, video]) =>
      setLists({ coding, office, video }),
    )
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const list = lists[mode]
  const switches = mode === 'office' ? officeToolSwitches : mode === 'video' ? videoToolSwitches : toolSwitches

  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    await actions.setToolSwitch(name, enabled, mode)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const isEnabled = (name: string): boolean => switches[name] !== false
  const enabledCount = list.filter((t) => isEnabled(t.name)).length

  return (
    <div className="settings-page">
      <h2>工具开关</h2>
      <p className="hint-line">
        控制各模式下哪些工具随请求发给模型：被禁用的工具不会出现在 tools 列表里，模型不会调用它。
        三个模式的开关相互独立。当前（{MODE_LABEL[mode]}）启用 {enabledCount} / {list.length} 个。
      </p>

      <div className="task-mode-switch" role="group" aria-label="模式" style={{ marginBottom: 12, width: 330 }}>
        <button aria-pressed={mode === 'coding'} className={mode === 'coding' ? 'active' : ''} onClick={() => setMode('coding')}>
          编程模式
        </button>
        <button aria-pressed={mode === 'office'} className={mode === 'office' ? 'active' : ''} onClick={() => setMode('office')}>
          办公模式
        </button>
        <button aria-pressed={mode === 'video'} className={mode === 'video' ? 'active' : ''} onClick={() => setMode('video')}>
          视频模式
        </button>
      </div>

      {list.map((t) => (
        <div className="features-row" key={`${mode}:${t.name}`}>
          <div className="features-text">
            <span className="features-label">
              <code className="tool-switch-name">{t.name}</code>
              {t.requiresApproval ? <span className="badge">需批准</span> : null}
              {t.kind ? <span className="badge">{KIND_LABEL[t.kind] ?? t.kind}</span> : null}
            </span>
            <small>{t.description}</small>
          </div>
          <label className="features-toggle">
            <input
              type="checkbox"
              aria-label={`启用 ${t.name}`}
              checked={isEnabled(t.name)}
              onChange={(e) => void toggle(t.name, e.target.checked)}
            />
            启用
          </label>
        </div>
      ))}

      <div className="settings-page-actions">
        <div className="spacer" />
        {saved ? <span className="saved-hint" role="status"><Icon name="check" size={14} />已保存，下一轮对话生效</span> : null}
      </div>
    </div>
  )
}
