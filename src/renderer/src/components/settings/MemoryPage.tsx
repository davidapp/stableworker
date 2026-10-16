import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../../store'

interface Layer {
  label: string
  path: string
  raw: string | null
}

type Kind = 'global' | 'project' | 'local'

/** 记忆页：分层记忆（全局 → 项目 → 项目本地）的可视化编辑；@路径 引用与 memory 工具目录见提示 */
export function MemoryPage() {
  const { activeProjectId } = useApp()
  const [layers, setLayers] = useState<Layer[]>([])
  const [editing, setEditing] = useState<{ kind: Kind; content: string } | null>(null)
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!activeProjectId) {
      setLayers([])
      return
    }
    const r = await window.api.getMemoryLayers(activeProjectId)
    setLayers(r.layers)
  }, [activeProjectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const pathOf = (kind: Kind): string | undefined => {
    if (kind === 'global') return layers.find((l) => l.label === '全局')?.path
    if (kind === 'project') return layers.find((l) => l.label === '项目')?.path
    return layers.find((l) => l.label === '项目本地')?.path
  }

  const rawOf = (kind: Kind): string | null => {
    const p = pathOf(kind)
    return p ? (layers.find((l) => l.path === p)?.raw ?? null) : null
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    if (!activeProjectId && editing.kind !== 'global') {
      setNotice('❌ 项目层需要先激活一个项目')
      return
    }
    setNotice('')
    const r = await window.api.saveMemoryLayer(activeProjectId ?? '', editing.kind, editing.content)
    setNotice(r.ok ? '✅ 已保存（下一轮对话生效）' : `❌ ${r.error ?? '保存失败'}`)
    if (r.ok) {
      setEditing(null)
      await refresh()
    }
  }

  const editorFor = (kind: Kind, title: string, hint: string): ReactNode => {
    const raw = rawOf(kind)
    const isEditing = editing?.kind === kind
    return (
      <div style={{ marginBottom: 14 }}>
        <div className="ctx-title-row">
          <span>{title}</span>
          <span className="ctx-value" title={pathOf(kind)}>
            {pathOf(kind) ?? '（需激活项目）'}
          </span>
        </div>
        {isEditing ? (
          <>
            <textarea
              className="holidays-input"
              rows={8}
              value={editing.content}
              onChange={(e) => setEditing({ kind, content: e.target.value })}
            />
            <div className="ctx-btn-row">
              <button className="btn" onClick={() => setEditing(null)}>
                取消
              </button>
              <div className="spacer" />
              <button className="btn btn-primary" onClick={() => void save()}>
                保存
              </button>
            </div>
          </>
        ) : (
          <div className="ctx-btn-row">
            <span className="ctx-value">{raw == null ? '（未创建）' : `${raw.length} 字符`}</span>
            <div className="spacer" />
            <button
              className="btn"
              disabled={kind !== 'global' && !activeProjectId}
              onClick={() => setEditing({ kind, content: raw ?? '' })}
            >
              {raw == null ? '创建' : '编辑'}
            </button>
          </div>
        )}
        <div className="hint-line">{hint}</div>
      </div>
    )
  }

  return (
    <div className="settings-page">
      <h2>记忆</h2>
      <p className="hint-line">
        分层记忆按 全局 → 项目 → 项目本地 顺序注入系统提示词（近处优先），支持整行{' '}
        <code className="tool-switch-name">@相对路径</code> 引用其他文件。此外模型还有 memory
        工具（跨会话记忆目录，按项目隔离，索引 MEMORY.md）——记忆目录在用户数据区，不进项目仓库。
      </p>

      {editorFor('global', '全局（所有项目共享）', '放在应用数据目录；适合个人通用偏好（语言、风格、通用规范）。')}
      {editorFor('project', '项目（AGENTS.md）', '随项目进版本库，团队共享；适合技术栈、目录结构、编码规范。')}
      {editorFor('local', '项目本地（AGENTS.local.md）', '个人覆盖，建议加入 .gitignore；适合个人的临时约定。')}
      <div className="saved-hint">{notice}</div>
    </div>
  )
}
