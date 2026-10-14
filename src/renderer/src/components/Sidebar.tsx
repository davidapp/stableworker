import { useState } from 'react'
import type { SessionMeta } from '../../../shared/types'
import { useApp } from '../store'
import * as actions from '../actions'
import { Icon } from './Icon'

/** 侧栏：项目树。项目可展开出会话叶子；叶子右键可重命名/删除；项目行上的 ＋ 新建会话 */
export function Sidebar() {
  const { projects, activeProjectId, activeSessionId, sessionsByProject, expandedProjects, taskMode } = useApp()
  const office = taskMode === 'office'
  const visibleProjects = projects.filter((p) => office ? p.id === 'office-workspace' : p.id !== 'office-workspace')
  const [menu, setMenu] = useState<{ x: number; y: number; projectId: string; session: SessionMeta } | null>(null)
  const [renaming, setRenaming] = useState<{ projectId: string; id: string; value: string } | null>(null)

  const commitRename = (): void => {
    if (!renaming) return
    void actions.renameSession(renaming.projectId, renaming.id, renaming.value)
    setRenaming(null)
  }

  return (
    <aside className="sidebar" aria-label="工作区导航">
      <div className="sidebar-brand"><span className="brand-mark"><Icon name="logo" size={18} /></span><span>StableWorker</span></div>
      <div className="task-mode-switch" role="group" aria-label="工作模式">
        <button aria-pressed={!office} className={!office ? 'active' : ''} onClick={() => void actions.switchTaskMode('coding')}><Icon name="code" size={14} /> 编程</button>
        <button aria-pressed={office} className={office ? 'active' : ''} onClick={() => void actions.switchTaskMode('office')}><Icon name="briefcase" size={14} /> 办公</button>
      </div>
      <button className="btn btn-block" onClick={() => void (office ? actions.newOfficeTask() : actions.addProject())}>
        <Icon name="plus" /> {office ? '新建办公任务' : '新建项目'}
      </button>
      <div className="sidebar-section-label">{office ? '办公任务' : '工作区'} <span>{office ? (sessionsByProject['office-workspace'] ?? []).length : visibleProjects.length}</span></div>
      <ul className="project-list">
        {visibleProjects.map((p) => {
          const expanded = office || (expandedProjects[p.id] ?? false)
          const sessions = sessionsByProject[p.id] ?? []
          return (
            <li key={p.id} className={`project-node ${office ? 'office-task-node' : ''}`}>
              {!office && <div className={`project-row ${p.id === activeProjectId ? 'active' : ''}`}>
                <button
                  className="chevron"
                  title={expanded ? '折叠' : '展开会话'}
                  aria-expanded={expanded}
                  onClick={() => actions.toggleProjectExpanded(p.id)}
                >
                  <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
                </button>
                <span className="project-name" title={p.path} onClick={() => void actions.selectProject(p.id)}>
                  <Icon name="folder" size={15} />
                  {p.name}
                </span>
                <button
                  className="icon-btn project-add"
                  title="在此项目下新建会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    void actions.newSessionInProject(p.id)
                  }}
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>}

              {expanded ? (
                <ul className="session-list">
                  {sessions.length === 0 ? <li className="session-empty">{office ? '新建任务，开始整理资料' : '（暂无会话，点 ＋ 新建）'}</li> : null}
                  {sessions.map((s) =>
                    renaming && renaming.id === s.id && renaming.projectId === p.id ? (
                      <li key={s.id} className="session-leaf">
                        <input
                          className="rename-input"
                          autoFocus
                          value={renaming.value}
                          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename()
                            else if (e.key === 'Escape') setRenaming(null)
                          }}
                          onBlur={commitRename}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </li>
                    ) : (
                      <li
                        key={s.id}
                        className={`session-leaf ${s.id === activeSessionId && p.id === activeProjectId ? 'active' : ''}`}
                        title={s.title}
                        onClick={() => void actions.selectSession(p.id, s.id)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setMenu({ x: e.clientX, y: e.clientY, projectId: p.id, session: s })
                        }}
                      >
                        <Icon name={s.damaged ? 'warning' : office ? 'file' : 'chat'} size={14} />
                        <span className="session-title">
                          {s.title}
                        </span>
                        <button
                          className="icon-btn session-delete"
                          title="删除会话"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (window.confirm(office ? `删除办公任务「${s.title}」？消息、导入资料和生成文件将一并删除，不可恢复。` : `删除会话「${s.title}」？消息记录将一并删除，不可恢复。`)) {
                              void actions.deleteSession(p.id, s.id)
                            }
                          }}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              ) : null}
            </li>
          )
        })}
        {!office && visibleProjects.length === 0 ? <li className="sidebar-empty"><Icon name="folder" size={24} /><span>还没有工作区</span><small>添加本地目录，开始协作</small></li> : null}
      </ul>

      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          <button className="icon-btn-lg" title="设置" onClick={() => actions.openSettings()}>
            <Icon name="settings" /> <span>设置</span>
          </button>
          <button className="icon-btn-lg" title="搜索所有会话" aria-label="搜索所有会话" onClick={() => void window.api.openSearchWindow()}>
            <Icon name="search" />
          </button>
          <button
            className="icon-btn-lg"
            title="API 调试（Ctrl+Alt+D）"
            aria-label="API 调试"
            onClick={() => void window.api.openInspector()}
          >
            <Icon name="terminal" />
          </button>
        </div>
      </div>

      {/* 会话叶子的右键菜单 */}
      {menu ? (
        <>
          <div
            className="popover-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 170), top: menu.y }}>
            <button
              className="ctx-menu-item"
              onClick={() => {
                setRenaming({ projectId: menu.projectId, id: menu.session.id, value: menu.session.title })
                setMenu(null)
              }}
            >
              <Icon name="edit" size={14} /> 重命名
            </button>
            <button
              className="ctx-menu-item danger"
              onClick={() => {
                if (window.confirm(menu.projectId === 'office-workspace' ? `删除办公任务「${menu.session.title}」？消息、导入资料和生成文件将一并删除，不可恢复。` : `删除会话「${menu.session.title}」？消息记录将一并删除，不可恢复。`)) {
                  void actions.deleteSession(menu.projectId, menu.session.id)
                }
                setMenu(null)
              }}
            >
              <Icon name="trash" size={14} /> 删除会话
            </button>
          </div>
        </>
      ) : null}
    </aside>
  )
}
