import { useEffect, useRef, useState } from 'react'
import type { OfficeFile } from '../../../shared/types'
import { useApp } from '../store'
import * as actions from '../actions'
import { ApprovalModeMenu } from './ApprovalModeMenu'
import { ThinkingEffortMenu } from './ThinkingEffortMenu'
import { ContextMeter } from './ContextMeter'
import { CaretIcon } from './CaretIcon'
import { Icon } from './Icon'

export function Composer({ disabled, attachments = [], onAttach, onRemove, onSend, taskDraft }: { disabled: boolean; attachments?: OfficeFile[]; onAttach?: () => void; onRemove?: (path: string) => void; onSend?: (text: string) => void; taskDraft?: { id: number; text: string } | null }) {
  const { llmProfiles, activeLlmId, activeSessionId, taskMode } = useApp()
  const office = taskMode === 'office'
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setText('') }, [activeSessionId, taskMode])
  useEffect(() => {
    if (!taskDraft) return
    setText((previous) => previous.trim() ? `${previous}\n\n${taskDraft.text}` : taskDraft.text)
    textareaRef.current?.focus()
  }, [taskDraft])

  const submit = (): void => {
    const content = text.trim()
    if ((!content && attachments.length === 0) || disabled) return
    setText('')
    if (onSend) onSend(content || '请阅读这些资料，并整理主要内容。')
    else void actions.sendChat(content)
  }

  return (
    <footer className="composer">
      <div className="composer-box">
        {office && attachments.length > 0 && <div className="office-attachment-chips">{attachments.map((file) => <span key={file.path}><Icon name="attachment" size={12} /><span title={file.name}>{file.name}</span><button className="icon-btn" aria-label={`移除附件 ${file.name}`} onClick={() => onRemove?.(file.path)}><Icon name="close" size={12} /></button></span>)}</div>}
        <textarea
          ref={textareaRef}
          aria-label="消息"
          value={text}
          placeholder={office ? '描述要完成的工作，或添加资料开始' : '输入消息，Enter 发送，Shift+Enter 换行'}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // isComposing：中文输入法选词时的 Enter 不应当作发送
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-row">
          {office && <button className="icon-btn-lg" title="添加办公资料" disabled={disabled} onClick={onAttach}><Icon name="attachment" /></button>}
          <ApprovalModeMenu />
          <div className="spacer" />
          <ContextMeter />
          <div className="model-select-wrap">
            <select
              className="model-select"
              value={activeLlmId ?? ''}
              title="切换模型配置档"
              onChange={(e) => {
                if (e.target.value) void actions.setActiveLlm(e.target.value)
              }}
            >
              {llmProfiles.length === 0 ? (
                <option value="">未配置模型</option>
              ) : (
                llmProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model}
                  </option>
                ))
              )}
            </select>
            <CaretIcon />
          </div>
          <ThinkingEffortMenu />
        {disabled ? (
          <button className="composer-send stop" title="停止生成" onClick={() => void actions.stopChat()}>
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            className="composer-send"
            title="发送（Enter）"
            disabled={!text.trim() && attachments.length === 0}
            onClick={submit}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
        </div>
      </div>
      <div className="composer-hint"><span>{office ? '资料仅导入当前任务 · 生成结果可预览和打开' : '结合项目文件与你协作'}</span><span><kbd>Enter</kbd> 发送 · <kbd>Shift + Enter</kbd> 换行</span></div>
    </footer>
  )
}
