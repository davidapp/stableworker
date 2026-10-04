import { useApp } from '../store'
import * as actions from '../actions'

export function Sidebar() {
  const { projects, activeProjectId, llm } = useApp()

  return (
    <aside className="sidebar">
      <div className="brand">StableWorker</div>

      <div className="section-title">项目</div>
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
        <div className={`llm-status ${llm ? 'ok' : 'warn'}`} title={llm?.baseURL ?? ''}>
          {llm ? `${llm.name} · ${llm.model}` : 'LLM 未配置'}
        </div>
        <button className="btn btn-block" onClick={() => actions.openInspector()}>
          🔍 API 调试
        </button>
        <button className="btn btn-block" onClick={() => actions.openSettings()}>
          ⚙ LLM 设置
        </button>
      </div>
    </aside>
  )
}
