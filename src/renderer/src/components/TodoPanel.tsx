import { useApp } from '../store'

const ICON: Record<string, string> = {
  completed: '✓',
  in_progress: '◐',
  pending: '○',
}

/** 任务清单面板（todo_write 工具维护），显示在消息列表上方 */
export function TodoPanel() {
  const { todos } = useApp()
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length

  return (
    <div className="todo-panel">
      <div className="todo-panel-head">
        <span>任务清单</span>
        <span className="ctx-value">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="todo-list">
        {todos.map((t) => (
          <li key={t.id} className={`todo-item todo-${t.status}`}>
            <span className="todo-icon">{ICON[t.status] ?? '○'}</span>
            <span className="todo-content">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
