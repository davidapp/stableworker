import { useState } from 'react'
import { useApp } from '../store'
import * as actions from '../actions'
import { ApprovalModeMenu } from './ApprovalModeMenu'
import { ThinkingEffortMenu } from './ThinkingEffortMenu'
import { ContextMeter } from './ContextMeter'

export function Composer({ disabled }: { disabled: boolean }) {
  const { llmProfiles, activeLlmId } = useApp()
  const [text, setText] = useState('')

  const submit = (): void => {
    const content = text.trim()
    if (!content || disabled) return
    setText('')
    void actions.sendChat(content)
  }

  return (
    <footer className="composer">
      <div className="composer-box">
        <textarea
          value={text}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
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
            <span className="mode-caret">⌄</span>
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
            disabled={!text.trim()}
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
    </footer>
  )
}
