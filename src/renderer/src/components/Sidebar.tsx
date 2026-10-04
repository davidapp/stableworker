import { useApp } from '../store'
import * as actions from '../actions'

export function Sidebar() {
  const { projects, activeProjectId } = useApp()

  return (
    <aside className="sidebar">
      <button className="btn btn-block" onClick={() => void actions.addProject()}>
        ＋ 添加项目
      </button>
      <ul className="project-list">
        {projects.map((p) => (
          <li
            key={p.id}
            className={`project-item ${p.id === activeProjectId ? 'active' : ''}`}
            title={p.path}
            onClick={() => void actions.selectProject(p.id)}
          >
            <span className="project-name">{p.name}</span>
            <button
              className="icon-btn"
              title="移除项目（不删除磁盘文件）"
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(`移除项目「${p.name}」？（不会删除磁盘上的文件）`)) void actions.removeProject(p.id)
              }}
            >
              ×
            </button>
          </li>
        ))}
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
    </aside>
  )
}
