import { useEffect, useMemo, useRef, useState } from 'react'
import { diffLines } from '../../../shared/diff'
import type { ToolUseBlock } from '../../../shared/types'
import { copyText } from '../clipboard'
import { Icon } from './Icon'

/** 参数展示截断：write_file 这类工具的 content 可能非常大 */
const MAX_ARGS_DISPLAY = 800

/** 执行中的实时输出：内容更新时自动滚到底部 */
function LiveOutput({ text, label }: { text: string; label: string }) {
  const ref = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <div className="tool-live">
      <div className="tool-live-label">{label}</div>
      <pre ref={ref}>{text}</pre>
    </div>
  )
}

/** 工具调用卡片：显示工具名、参数、执行状态；危险操作显示批准按钮；结果默认折叠 */
export function ToolCallCard({ block, onRestore }: { block: ToolUseBlock; onRestore?: () => void }) {
  const [answered, setAnswered] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [copied, setCopied] = useState(false)
  const [answer, setAnswer] = useState<string | null>(null)
  const [customAnswer, setCustomAnswer] = useState('')

  const respond = async (approved: boolean, alwaysAllow?: boolean): Promise<void> => {
    if (answered || !block.approvalId) return
    setAnswered(true)
    if (approved && alwaysAllow && block.approvalSuggest) {
      await window.api.addPermissionRule(block.approvalSuggest)
    }
    const res = await window.api.respondApproval(block.approvalId, approved)
    if (!res.ok) setInvalid(true)
  }

  // ask_user_question：把用户选择/输入作为工具结果回传
  const answerQuestion = async (answerText: string): Promise<void> => {
    if (answerText.trim() === '' || !block.userQuestion) return
    setAnswer(answerText)
    await window.api.respondAskUser(block.userQuestion.id, answerText)
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

  // 编辑类工具（oldText/newText）：渲染红绿 diff 代替原始参数
  const isEdit = typeof block.input.oldText === 'string' && typeof block.input.newText === 'string'
  const diff = useMemo(
    () =>
      isEdit
        ? diffLines(block.input.oldText as string, block.input.newText as string)
        : null,
    [isEdit, block.input],
  )

  return (
    <div className={`tool-card ${block.status}`}>
      <div className="tool-card-head">
        <Icon name={block.name === 'task' ? 'chat' : 'terminal'} size={14} />
        <span className="tool-name">{block.name === 'task' ? '子代理（task）' : block.name}</span>
        {block.status === 'pending_approval' ? <span className="tool-status pending">等待批准</span> : null}
        {block.status === 'running' ? <span className="tool-status running">运行中…</span> : null}
        {block.status === 'done' ? (
          <span className="tool-status done">✓{block.durationMs != null ? ` ${block.durationMs}ms` : ''}</span>
        ) : null}
        {block.status === 'error' ? <span className="tool-status error">✗ 失败</span> : null}
        <button className="tool-copy-btn" title="复制参数 JSON" onClick={() => void copyArgs()}>
          {copied ? '✓' : '复制'}
        </button>
        {['write_file', 'edit_file', 'multi_edit', 'office_create_document', 'office_edit_document', 'office_calculate_spreadsheet'].includes(block.name) && block.status === 'done' ? (
          block.rolledBack ? (
            <span className="tool-status rolled">已回滚</span>
          ) : onRestore ? (
            <button className="tool-copy-btn" title="回滚到本次修改之前的状态" onClick={onRestore}>
              回滚
            </button>
          ) : null
        ) : null}
      </div>

      {block.userQuestion && !answer ? (
        <div className="tool-question">
          <div className="tool-question-text">{block.userQuestion.question}</div>
          {block.status === 'pending_approval' || block.status === 'running' ? (
            <>
              <div className="ctx-btn-row">
                {block.userQuestion.options.map((o) => (
                  <button key={o} className="btn" onClick={() => void answerQuestion(o)}>
                    {o}
                  </button>
                ))}
              </div>
              <div className="ctx-btn-row">
                <input
                  className="rename-input"
                  placeholder="或输入自定义回答…"
                  value={customAnswer}
                  onChange={(e) => setCustomAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customAnswer.trim()) void answerQuestion(customAnswer.trim())
                  }}
                />
                <button className="btn" disabled={!customAnswer.trim()} onClick={() => void answerQuestion(customAnswer.trim())}>
                  提交
                </button>
              </div>
            </>
          ) : (
            <div className="tool-question-answered">该提问已失效（超时或已停止），可让模型重新提问。</div>
          )}
        </div>
      ) : null}
      {answer !== null ? (
        <div className="tool-question-answered">已回答：{answer}（等待模型继续…）</div>
      ) : null}

      {block.status === 'pending_approval' ? (
        <div className="tool-approve">
          <span className="tool-approve-text"><Icon name="shield" size={14} /> 该操作会修改你的磁盘，需要你的批准</span>
          {answered ? (
            <span className="tool-status running">已响应…</span>
          ) : invalid ? (
            <span className="tool-status error">批准已失效</span>
          ) : (
            <span className="tool-approve-btns">
              <button className="btn btn-primary" onClick={() => void respond(true)}>
                允许
              </button>
              {block.approvalSuggest ? (
                <button className="btn" title={`添加规则：${block.approvalSuggest}`} onClick={() => void respond(true, true)}>
                  允许并不再询问
                </button>
              ) : null}
              <button className="btn" onClick={() => void respond(false)}>
                拒绝
              </button>
            </span>
          )}
        </div>
      ) : null}

      {block.status === 'running' && block.output ? (
        <LiveOutput text={block.output} label={block.name === 'task' ? '子代理实时输出' : '实时输出'} />
      ) : null}

      {diff ? (
        <div className="tool-diff">
          <div className="tool-diff-path">
            {typeof block.input.path === 'string' ? block.input.path : '(未指定路径)'}
          </div>
          {diff.map((line, i) => (
            <div key={i} className={`diff-line diff-${line.type}`}>
              {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
              {line.text}
            </div>
          ))}
        </div>
      ) : (
        <pre className="tool-args">{argsText}</pre>
      )}

      {block.result != null ? (
        <details className="tool-result">
          <summary>{block.status === 'error' ? '错误详情' : '查看结果'}</summary>
          <pre>{block.result}</pre>
        </details>
      ) : null}
    </div>
  )
}
