import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../../store'
import type { SkillMeta } from '../../../../shared/types'
import { parseSkillFrontmatter } from '../../../../shared/skillFrontmatter'
import { Icon } from '../Icon'
import { SettingsNotice, type SettingsNoticeValue } from './SettingsNotice'

/** 斜杠命令页：管理全局（userData/skills）与项目级（.stableworker/commands）命令，同名项目优先 */
export function SkillsPage() {
  const { activeProjectId } = useApp()
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [editing, setEditing] = useState<{ name: string; content: string; scope: SkillMeta['scope']; isNew: boolean } | null>(null)
  const [notice, setNotice] = useState<SettingsNoticeValue | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setSkills(await window.api.listSkills())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async (): Promise<void> => {
    if (!editing) return
    const r = await window.api.saveSkill(editing.name, editing.content, editing.scope)
    if (!r.ok) {
      setNotice({ tone: 'error', text: r.error ?? '保存失败' })
      return
    }
    setNotice({ tone: 'success', text: '已保存' })
    setEditing(null)
    await refresh()
  }

  const remove = async (s: SkillMeta): Promise<void> => {
    if (!window.confirm(`删除${s.scope === 'project' ? '项目级' : '全局'}命令 /${s.name}？`)) return
    await window.api.deleteSkill(s.name, s.scope)
    await refresh()
  }

  const scopeLabel = (scope: SkillMeta['scope']): string => (scope === 'project' ? '项目' : '全局')

  return (
    <div className="settings-page">
      <h2>斜杠命令</h2>
      <p className="hint-line">
        在输入框输入 <code className="tool-switch-name">/名称 参数</code> 触发，模板中的 $ARGUMENTS 会被替换为参数。
        全局命令存于应用数据目录；项目级命令存于 <code className="tool-switch-name">&lt;项目&gt;/.stableworker/commands/</code>
        （可与项目一起进版本库），同名时项目覆盖全局。
        模板支持 frontmatter：description（列表说明）/ allowed-tools（逗号分隔，触发后的本轮对话只可用这些工具）/
        model（按模型名覆盖配置档）；正文支持 !`命令` 内嵌执行（输出就地注入，10 秒超时）。
      </p>

      {editing ? (
        <>
          <div className="field">
            <span>命令名（触发为 /名称）</span>
            <input
              aria-label="命令名"
              value={editing.name}
              placeholder="例如 commit"
              disabled={!editing.isNew}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </div>
          {!editing.isNew ? null : (
            <div className="field">
              <span>保存位置</span>
              <div className="settings-radio-group">
                <label>
                  <input
                    type="radio"
                    name="skill-scope"
                    checked={editing.scope === 'global'}
                    onChange={() => setEditing({ ...editing, scope: 'global' })}
                  />{' '}
                  全局（所有项目可用）
                </label>
                <label>
                  <input
                    type="radio"
                    name="skill-scope"
                    checked={editing.scope === 'project'}
                    disabled={!activeProjectId}
                    onChange={() => setEditing({ ...editing, scope: 'project' })}
                  />{' '}
                  项目级{activeProjectId ? '' : '（需先激活一个项目）'}
                </label>
              </div>
            </div>
          )}
          <div className="field">
            <span>模板内容（$ARGUMENTS = 全部参数，$1/$2 = 位置参数）</span>
            <textarea
              className="holidays-input"
              aria-label="模板内容"
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
            <SettingsNotice notice={notice} />
            <button className="btn btn-primary" onClick={() => void save()}>
              保存
            </button>
          </div>
        </>
      ) : (
        <>
          {skills.length === 0 ? (
            <div className="profile-empty">还没有自定义命令，创建一个模板来简化重复工作。</div>
          ) : (
            <div className="profile-list">
              {skills.map((s) => (
                <div className="profile-row" key={`${s.scope}:${s.name}`}>
                  <div className="profile-info">
                    <span className="profile-name">
                      <code className="tool-switch-name">/{s.name}</code>
                      <span className="settings-meta">
                        {scopeLabel(s.scope)}
                      </span>
                    </span>
                    <small>
                      {(() => {
                        const { meta, body } = parseSkillFrontmatter(s.content)
                        const tags = [meta.model ? `model: ${meta.model}` : '', meta.allowedTools?.length ? `tools: ${meta.allowedTools.join(',')}` : ''].filter(Boolean)
                        const desc = meta.description ?? body.split('\n')[0]
                        return `${desc.slice(0, 70)}${tags.length ? `（${tags.join(' · ')}）` : ''}`
                      })()}
                    </small>
                  </div>
                  <div className="profile-actions">
                    <button
                      className="btn"
                      onClick={() => setEditing({ name: s.name, content: s.content, scope: s.scope, isNew: false })}
                    >
                      <Icon name="edit" size={14} />编辑
                    </button>
                    <button className="btn btn-danger-ghost" onClick={() => void remove(s)}>
                      <Icon name="trash" size={14} />删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="settings-page-actions">
            <button
              className="btn btn-primary"
              onClick={() => setEditing({ name: '', content: '', scope: 'global', isNew: true })}
            >
              <Icon name="plus" size={14} />新建命令
            </button>
            <div className="spacer" />
            <SettingsNotice notice={notice} />
          </div>
        </>
      )}
    </div>
  )
}
