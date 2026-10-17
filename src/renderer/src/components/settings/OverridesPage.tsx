import { useEffect, useState } from 'react'
import { useApp } from '../../store'
import type { ApprovalMode, ProjectOverrides } from '../../../../shared/types'

interface ToolMeta {
  name: string
  description: string
  requiresApproval: boolean
  kind: string | undefined
}

const MODE_LABEL: Record<ApprovalMode, string> = {
  plan: '📋 规划模式',
  confirm: '✋ 变更前确认',
  autoEdit: '🛡️ 自动编辑',
  fullAccess: '⚠️ 完全访问',
}

/** 项目覆盖页：批准模式 / 工具开关 / 权限规则的项目级覆盖（未指定 = 继承全局） */
export function OverridesPage() {
  const { activeProjectId, projects, approvalMode, toolSwitches, projectOverrides } = useApp()
  const [tools, setTools] = useState<ToolMeta[]>([])
  const [mode, setMode] = useState<'inherit' | ApprovalMode>('inherit')
  const [switches, setSwitches] = useState<Record<string, boolean | 'inherit'>>({})
  const [rules, setRules] = useState<{ inherit: boolean; deny: string; ask: string; allow: string }>({
    inherit: true,
    deny: '',
    ask: '',
    allow: '',
  })
  const [notice, setNotice] = useState('')

  const override = activeProjectId ? projectOverrides[activeProjectId] : undefined

  useEffect(() => {
    void window.api.listTools().then(setTools)
  }, [])

  // 激活项目或覆盖配置变化时，用"已保存的覆盖 + 全局值"重置编辑状态
  useEffect(() => {
    const sw: Record<string, boolean | 'inherit'> = {}
    for (const t of tools) sw[t.name] = override?.toolSwitches?.[t.name] ?? 'inherit'
    setSwitches(sw)
    setMode(override?.approvalMode ?? 'inherit')
    const pr = override?.permissionRules
    setRules({
      inherit: !pr,
      deny: (pr?.deny ?? []).join('\n'),
      ask: (pr?.ask ?? []).join('\n'),
      allow: (pr?.allow ?? []).join('\n'),
    })
    setNotice('')
  }, [activeProjectId, tools, override])

  const save = async (): Promise<void> => {
    if (!activeProjectId) return
    const clean: ProjectOverrides = {}
    if (mode !== 'inherit') clean.approvalMode = mode
    const sw: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(switches)) if (v !== 'inherit') sw[k] = v
    if (Object.keys(sw).length > 0) clean.toolSwitches = sw
    if (!rules.inherit) {
      const lines = (t: string): string[] => t.split('\n').map((x) => x.trim()).filter(Boolean)
      const pr = { deny: lines(rules.deny), ask: lines(rules.ask), allow: lines(rules.allow) }
      if (pr.deny.length || pr.ask.length || pr.allow.length) clean.permissionRules = pr
    }
    await window.api.setProjectOverrides(activeProjectId, clean)
    setNotice('✅ 已保存（下一轮对话生效）')
  }

  const projectName = projects.find((p) => p.id === activeProjectId)?.name

  return (
    <div className="settings-page">
      <h2>项目覆盖</h2>
      <p className="hint-line">
        为单个项目覆盖三项关键设置（未指定的继承全局；权限规则与全局**合并**生效，deny &gt; ask &gt; allow）。
        {projectName ? <>当前目标项目：<code className="tool-switch-name">{projectName}</code></> : '需先在侧栏激活一个项目。'}
      </p>

      {!activeProjectId ? null : (
        <>
          <div className="field">
            <span>批准模式（全局当前：{MODE_LABEL[approvalMode]}）</span>
            <div>
              {(['inherit', 'plan', 'confirm', 'autoEdit', 'fullAccess'] as ('inherit' | ApprovalMode)[]).map((m) => (
                <label key={m} style={{ marginRight: 14 }}>
                  <input type="radio" checked={mode === m} onChange={() => setMode(m)} />{' '}
                  {m === 'inherit' ? `继承全局（${MODE_LABEL[approvalMode]}）` : MODE_LABEL[m]}
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <span>工具开关（{Object.values(switches).filter((v) => v !== 'inherit').length} 项覆盖）</span>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border, #2c2f36)', borderRadius: 8, padding: '6px 10px' }}>
              {tools.map((t) => {
                const v = switches[t.name] ?? 'inherit'
                return (
                  <div key={t.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0' }}>
                    <code className="tool-switch-name" style={{ flex: 1 }}>{t.name}</code>
                    <small style={{ color: 'var(--text-2, #9aa0aa)' }}>
                      全局：{toolSwitches[t.name] === false ? '禁用' : '启用'}
                    </small>
                    <select
                      className="model-select"
                      style={{ maxWidth: 130 }}
                      value={String(v)}
                      onChange={(e) => {
                        const nv = e.target.value === 'inherit' ? ('inherit' as const) : e.target.value === 'true'
                        setSwitches({ ...switches, [t.name]: nv })
                      }}
                    >
                      <option value="inherit">继承全局</option>
                      <option value="true">启用</option>
                      <option value="false">禁用</option>
                    </select>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="field">
            <span>权限规则（每行一条 Tool(内容)，与全局合并生效）</span>
            <label style={{ display: 'block', marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={rules.inherit}
                onChange={(e) => setRules({ ...rules, inherit: e.target.checked })}
              />{' '}
              继承全局（不添加项目规则）
            </label>
            {!rules.inherit ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {(['deny', 'ask', 'allow'] as const).map((k) => (
                  <div key={k}>
                    <div className="hint-line" style={{ textTransform: 'uppercase' }}>{k}</div>
                    <textarea
                      className="holidays-input"
                      rows={5}
                      value={rules[k]}
                      placeholder={k === 'deny' ? 'run_command(rm *)' : k === 'ask' ? 'write_file(*)' : 'read_file(*)'}
                      onChange={(e) => setRules({ ...rules, [k]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="settings-page-actions">
            <div className="spacer" />
            {notice ? <span className="saved-hint">{notice}</span> : null}
            <button className="btn btn-primary" onClick={() => void save()}>
              保存覆盖
            </button>
          </div>
        </>
      )}
    </div>
  )
}
