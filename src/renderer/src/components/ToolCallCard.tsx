import type { ToolUseBlock } from '../../../shared/types'

/** 工具调用卡片：显示工具名、参数、执行状态，结果默认折叠 */
export function ToolCallCard({ block }: { block: ToolUseBlock }) {
  return (
    <div className={`tool-card ${block.status}`}>
      <div className="tool-card-head">
        <span>🛠</span>
        <span className="tool-name">{block.name}</span>
        {block.status === 'running' ? <span className="tool-status running">运行中…</span> : null}
        {block.status === 'done' ? (
          <span className="tool-status done">✓{block.durationMs != null ? ` ${block.durationMs}ms` : ''}</span>
        ) : null}
        {block.status === 'error' ? <span className="tool-status error">✗ 失败</span> : null}
      </div>
      <pre className="tool-args">{JSON.stringify(block.input, null, 2)}</pre>
      {block.result != null ? (
        <details className="tool-result">
          <summary>{block.status === 'error' ? '错误详情' : '查看结果'}</summary>
          <pre>{block.result}</pre>
        </details>
      ) : null}
    </div>
  )
}
