import { useState } from 'react'
import type { ToolUseBlock } from '../../../shared/types'
import { copyText } from '../clipboard'

/** 参数展示截断：write_file 这类工具的 content 可能非常大 */
const MAX_ARGS_DISPLAY = 800

/** 工具调用卡片：显示工具名、参数、执行状态；危险操作显示批准按钮；结果默认折叠 */
export function ToolCallCard({ block }: { block: ToolUseBlock }) {
  const [answered, setAnswered] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [copied, setCopied] = useState(false)

  const respond = async (approved: boolean): Promise<void> => {
    if (answered || !block.approvalId) return
    setAnswered(true)
    const res = await window.api.respondApproval(block.approvalId, approved)
    if (!res.ok) setInvalid(true)
  }

  const copyArgs = async (): Promise<void> => {
    await copyText(JSON.stringify(block.input, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const argsText = (() => {
    const s = JSON.stringify(block.input, null, 2)
    return s.length > MAX_ARGS_DISPLAY ? s.slice(0, MAX_ARGS_DISPLAY) + '\n…（参数过长，已截断显示）' : s
  })()

  return (
    <div className={`tool-card ${block.status}`}>
      <div className="tool-card-head">
        <span>🛠</span>
        <span className="tool-name">{block.name}</span>
        {block.status === 'pending_approval' ? <span className="tool-status pending">等待批准</span> : null}
        {block.status === 'running' ? <span className="tool-status running">运行中…</span> : null}
        {block.status === 'done' ? (
          <span className="tool-status done">✓{block.durationMs != null ? ` ${block.durationMs}ms` : ''}</span>
        ) : null}
        {block.status === 'error' ? <span className="tool-status error">✗ 失败</span> : null}
        <button className="tool-copy-btn" title="复制参数 JSON" onClick={() => void copyArgs()}>
          {copied ? '✓' : '复制'}
        </button>
      </div>

      {block.status === 'pending_approval' ? (
        <div className="tool-approve">
          <span className="tool-approve-text">⚠ 该操作会修改你的磁盘，需要你的批准</span>
          {answered ? (
            <span className="tool-status running">已响应…</span>
          ) : invalid ? (
            <span className="tool-status error">批准已失效</span>
          ) : (
            <span className="tool-approve-btns">
              <button className="btn btn-primary" onClick={() => void respond(true)}>
                允许
              </button>
              <button className="btn" onClick={() => void respond(false)}>
                拒绝
              </button>
            </span>
          )}
        </div>
      ) : null}

      <pre className="tool-args">{argsText}</pre>
      {block.result != null ? (
        <details className="tool-result">
          <summary>{block.status === 'error' ? '错误详情' : '查看结果'}</summary>
          <pre>{block.result}</pre>
        </details>
      ) : null}
    </div>
  )
}
