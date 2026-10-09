import { useState } from 'react'
import { useApp } from '../../store'
import * as actions from '../../actions'
import type { PermissionRules } from '../../../../shared/types'

const KINDS: { key: keyof PermissionRules; label: string; hint: string }[] = [
  { key: 'deny', label: '拒绝（deny）', hint: '命中即拒绝执行，不询问。每行一条规则' },
  { key: 'ask', label: '总是询问（ask）', hint: '命中则强制弹出批准卡片（即使开了完全访问）' },
  { key: 'allow', label: '允许（allow）', hint: '命中则自动放行（无需批准）' },
]

/** 权限规则页：Tool(内容) 语法，deny > ask > allow */
export function RulesPage() {
  const { permissionRules } = useApp()
  const [draft, setDraft] = useState<PermissionRules>(() => ({
    allow: [...(permissionRules.allow ?? [])],
    ask: [...(permissionRules.ask ?? [])],
    deny: [...(permissionRules.deny ?? [])],
  }))
  const [saved, setSaved] = useState(false)

  const save = async (): Promise<void> => {
    await actions.setPermissionRules(draft)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="settings-page">
      <h2>权限规则</h2>
      <p className="hint-line">
        语法 <code className="tool-switch-name">工具(内容)</code>，内容支持尾缀 <code className="tool-switch-name">*</code> 前缀通配
        （如 <code className="tool-switch-name">run_command(npm:*)</code>）。优先级：deny &gt; ask &gt; allow；
        allow 命中自动放行，ask 强制批准，deny 直接拒绝并告知模型。
      </p>

      {KINDS.map((k) => (
        <div className="field" key={k.key}>
          <span>{k.label}</span>
          <textarea
            className="holidays-input"
            rows={4}
            value={draft[k.key].join('\n')}
            placeholder={'run_command(npm:*)\nedit_file(src/*)'}
            onChange={(e) => setDraft({ ...draft, [k.key]: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
          />
          <small>{k.hint}</small>
        </div>
      ))}

      <div className="settings-page-actions">
        <div className="spacer" />
        {saved ? <span className="saved-hint">✅ 已保存，下一轮对话生效</span> : null}
        <button className="btn btn-primary" onClick={() => void save()}>
          保存
        </button>
      </div>
    </div>
  )
}
