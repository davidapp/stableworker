import { useState } from 'react'
import type { SessionMeta } from '../../../shared/types'
import { useApp } from '../store'
import * as actions from '../actions'

/** 侧栏：项目树。项目可展开出会话叶子；叶子右键可重命名/删除；项目行上的 ＋ 新建会话 */
export function Sidebar() {
  const { projects, activeProjectId, activeSessionId, sessionsByProject, expandedProjects } = useApp()
  const [menu, setMenu] = useState<{ x: number; y: number; projectId: string; session: SessionMeta } | null>(null)
  const [renaming, setRenaming] = useState<{ projectId: string; id: string; value: string } | null>(null)

  const commitRename = (): void => {
    if (!renaming) return
    void actions.renameSession(renaming.projectId, renaming.id, renaming.value)
    setRenaming(null)
  }

  return (
    <aside className="sidebar">
      <button className="btn btn-block" onClick={() => void actions.addProject()}>
        ＋ 新建项目
      </button>
      <ul className="project-list">
        {projects.map((p) => {
          const expanded = expandedProjects[p.id] ?? false
          const sessions = sessionsByProject[p.id] ?? []
          return (
            <li key={p.id} className="project-node">
              <div className={`project-row ${p.id === activeProjectId ? 'active' : ''}`}>
                <button
                  className="chevron"
                  title={expanded ? '折叠' : '展开会话'}
                  onClick={() => actions.toggleProjectExpanded(p.id)}
                >
                  {expanded ? '▾' : '▸'}
                </button>
                <span className="project-name" title={p.path} onClick={() => void actions.selectProject(p.id)}>
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
                  ＋
                </button>
              </div>

              {expanded ? (
                <ul className="session-list">
                  {sessions.length === 0 ? <li className="session-empty">（暂无会话，点 ＋ 新建）</li> : null}
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
                        <span className="session-title">{s.title}</span>
                      </li>
                    ),
                  )}
                </ul>
              ) : null}
            </li>
          )
        })}
        {projects.length === 0 ? <li className="session-empty">（还没有项目）</li> : null}
      </ul>

      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          <button className="icon-btn-lg" title="设置" onClick={() => actions.openSettings()}>
            ⚙
          </button>
          <button
            className="icon-btn-lg"
            title="API 调试（Ctrl+Alt+D）"
            onClick={() => void window.api.openInspector()}
          >
            🔍
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
              ✏️ 重命名
            </button>
            <button
              className="ctx-menu-item danger"
              onClick={() => {
                if (window.confirm(`删除会话「${menu.session.title}」？消息记录将一并删除，不可恢复。`)) {
                  void actions.deleteSession(menu.projectId, menu.session.id)
                }
                setMenu(null)
              }}
            >
              🗑 删除会话
            </button>
          </div>
        </>
      ) : null}
    </aside>
  )
}
