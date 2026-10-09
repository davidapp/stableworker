import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../../store'

interface SkillMeta {
  name: string
  content: string
}

/** 斜杠命令页：管理 userData/skills/*.md（/name 触发，$ARGUMENTS 占位） */
export function SkillsPage() {
  const { activeProjectId } = useApp()
  void activeProjectId
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [editing, setEditing] = useState<{ name: string; content: string; isNew: boolean } | null>(null)
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setSkills(await window.api.listSkills())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async (): Promise<void> => {
    if (!editing) return
    const r = await window.api.saveSkill(editing.name, editing.content)
    if (!r.ok) {
      setNotice(`❌ ${r.error ?? '保存失败'}`)
      return
    }
    setNotice('✅ 已保存')
    setEditing(null)
    await refresh()
  }

  const remove = async (name: string): Promise<void> => {
    if (!window.confirm(`删除斜杠命令 /${name}？`)) return
    await window.api.deleteSkill(name)
    await refresh()
  }

  return (
    <div className="settings-page">
      <h2>斜杠命令</h2>
      <p className="hint-line">
        在输入框输入 <code className="tool-switch-name">/名称 参数</code> 触发，模板中的 $ARGUMENTS 会被替换为参数。
        每条命令是 userData/skills/ 下的一个 .md 文件。
      </p>

      {editing ? (
        <>
          <div className="field">
            <span>命令名（触发为 /名称）</span>
            <input
              value={editing.name}
              placeholder="例如 commit"
              disabled={!editing.isNew}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </div>
          <div className="field">
            <span>模板内容（$ARGUMENTS = 全部参数，$1/$2 = 位置参数）</span>
            <textarea
              className="holidays-input"
              rows={10}
              value={editing.content}
              placeholder={'请 review 以下改动并给出意见：\n$ARGUMENTS'}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            />
          </div>
          <div className="settings-page-actions">
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
        <>
          {skills.length === 0 ? (
            <div className="profile-empty">还没有自定义命令。点下面"＋ 新建命令"创建。</div>
          ) : (
            <div className="profile-list">
              {skills.map((s) => (
                <div className="profile-row" key={s.name}>
                  <div className="profile-info">
                    <span className="profile-name">
                      <code className="tool-switch-name">/{s.name}</code>
                    </span>
                    <small>{s.content.split('\n')[0].slice(0, 80)}</small>
                  </div>
                  <div className="profile-actions">
                    <button
                      className="btn"
                      onClick={() => setEditing({ name: s.name, content: s.content, isNew: false })}
                    >
                      编辑
                    </button>
                    <button className="btn btn-danger-ghost" onClick={() => void remove(s.name)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="settings-page-actions">
            <button className="btn btn-primary" onClick={() => setEditing({ name: '', content: '', isNew: true })}>
              ＋ 新建命令
            </button>
            <div className="spacer" />
            {notice ? <span className="saved-hint">{notice}</span> : null}
          </div>
        </>
      )}
    </div>
  )
}
