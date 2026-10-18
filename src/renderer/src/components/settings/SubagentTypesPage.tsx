import { useState } from 'react'
import { useApp } from '../../store'
import type { SubagentTypeConfig } from '../../../../shared/types'
import { Icon } from '../Icon'
import { SettingsNotice, type SettingsNoticeValue } from './SettingsNotice'
import * as actions from '../../actions'

interface Draft extends SubagentTypeConfig {
  originalName: string
  isNew: boolean
}

/** 子代理页：维护自定义代理类型（task 工具 subagent_type 的动态枚举），内置类型不可覆盖 */
export function SubagentTypesPage() {
  // 列表直接来自 store（保存后 ConfigView 经 applyConfig 回流）
  const { subagentTypes: types } = useApp()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [notice, setNotice] = useState<SettingsNoticeValue | null>(null)

  const persist = async (list: SubagentTypeConfig[]): Promise<void> => {
    setNotice(null)
    await window.api.setSubagentTypes(list)
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    const name = draft.name.trim()
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      setNotice({ tone: 'error', text: '名称只能包含字母、数字、下划线和连字符' })
      return
    }
    if (name === 'general-purpose' || name === 'Explore') {
      setNotice({ tone: 'error', text: '不能使用内置类型名' })
      return
    }
    if (!draft.description.trim()) {
      setNotice({ tone: 'error', text: '请填写一句话说明（模型靠它选型）' })
      return
    }
    if (types.some((t) => t.name === name && name !== draft.originalName)) {
      setNotice({ tone: 'error', text: '已存在同名类型' })
      return
    }
    const entry: SubagentTypeConfig = {
      name,
      description: draft.description.trim(),
      tools: draft.tools,
      prompt: draft.prompt,
    }
    const list = draft.isNew
      ? [...types, entry]
      : types.map((t) => (t.name === draft.originalName ? entry : t))
    setDraft(null)
    await persist(list)
    setNotice({ tone: 'success', text: '已保存（下一轮对话生效）' })
  }

  const remove = async (t: SubagentTypeConfig): Promise<void> => {
    if (!(await actions.confirm(`删除自定义类型 ${t.name}？`))) return
    await persist(types.filter((x) => x.name !== t.name))
  }

  return (
    <div className="settings-page">
      <h2>子代理类型</h2>
      <p className="hint-line">
        内置 <code className="tool-switch-name">general-purpose</code>（全部工具）与{' '}
        <code className="tool-switch-name">Explore</code>（只读）之外，可以定义专属代理类型：
        指定工具范围和角色设定，模型调用 task 工具时会在 subagent_type 里看到它们。
        下一轮对话生效。
      </p>

      {draft ? (
        <>
          <div className="field">
            <span>类型名（模型传 subagent_type 用）</span>
            <input
              aria-label="类型名"
              value={draft.name}
              placeholder="例如 code-reviewer"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="field">
            <span>一句话说明（给模型看的选型依据）</span>
            <input
              aria-label="一句话说明"
              value={draft.description}
              placeholder="例如：按严重度输出代码评审意见"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          <div className="field">
            <span>工具范围</span>
            <div className="settings-radio-group">
              <label>
                <input
                  type="radio"
                  name="subagent-tools"
                  checked={draft.tools === 'all'}
                  onChange={() => setDraft({ ...draft, tools: 'all' })}
                />{' '}
                全部工具
              </label>
              <label>
                <input
                  type="radio"
                  name="subagent-tools"
                  checked={draft.tools === 'read-only'}
                  onChange={() => setDraft({ ...draft, tools: 'read-only' })}
                />{' '}
                只读（研究/评审类首选）
              </label>
            </div>
          </div>
          <div className="field">
            <span>角色设定（追加到子代理系统提示）</span>
            <textarea
              className="holidays-input"
              aria-label="角色设定"
              rows={6}
              value={draft.prompt}
              placeholder={'你是代码评审专家。评审输出按以下分节：\n## 严重度（高/中/低）\n## 位置（文件:行号）\n## 建议'}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            />
          </div>
          <div className="settings-page-actions">
            <button className="btn" onClick={() => setDraft(null)}>
              取消
            </button>
            <div className="spacer" />
            <SettingsNotice notice={notice} />
            <button className="btn btn-primary" onClick={() => void saveDraft()}>
              保存
            </button>
          </div>
        </>
      ) : (
        <>
          {types.length === 0 ? (
            <div className="profile-empty">还没有自定义类型。创建专属代理，或使用内置的通用与探索代理。</div>
          ) : (
            <div className="profile-list">
              {types.map((t) => (
                <div className="profile-row" key={t.name}>
                  <div className="profile-info">
                    <span className="profile-name">
                      <code className="tool-switch-name">{t.name}</code>
                      <span className="settings-meta">
                        {t.tools === 'read-only' ? '只读' : '全部工具'}
                      </span>
                    </span>
                    <small>{t.description}</small>
                  </div>
                  <div className="profile-actions">
                    <button
                      className="btn"
                      onClick={() => setDraft({ ...t, originalName: t.name, isNew: false })}
                    >
                      <Icon name="edit" size={14} />编辑
                    </button>
                    <button className="btn btn-danger-ghost" onClick={() => void remove(t)}>
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
              onClick={() =>
                setDraft({ name: '', description: '', tools: 'read-only', prompt: '', originalName: '', isNew: true })
              }
            >
              <Icon name="plus" size={14} />新增类型
            </button>
            <div className="spacer" />
            <SettingsNotice notice={notice} />
          </div>
        </>
      )}
    </div>
  )
}
