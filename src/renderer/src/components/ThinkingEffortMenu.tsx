import { useState } from 'react'
import { useApp } from '../store'
import * as actions from '../actions'

const LEVELS: { id: 'off' | 'low' | 'medium' | 'high'; label: string }[] = [
  { id: 'off', label: '默认' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
]

/** 思考力度选择器：写入激活配置档，随请求发给模型（OpenAI 系 reasoning_effort / Anthropic thinking） */
export function ThinkingEffortMenu() {
  const { llmProfiles, activeLlmId } = useApp()
  const [open, setOpen] = useState(false)
  const active = llmProfiles.find((p) => p.id === activeLlmId) ?? null
  const current = active?.thinkingEffort ?? 'off'
  const currentLabel = LEVELS.find((l) => l.id === current)?.label ?? '默认'

  return (
    <div className="mode-menu-wrap">
      <button className="mode-btn" onClick={() => setOpen((v) => !v)} title="思考力度（推理模型）">
        <span>🧠 {currentLabel}</span>
        <span className="mode-caret">⌄</span>
      </button>

      {open ? (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="mode-menu">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                className={`mode-item ${l.id === current ? 'active' : ''}`}
                onClick={() => {
                  void actions.setThinkingEffort(l.id)
                  setOpen(false)
                }}
              >
                <span className="mode-texts">
                  <span className="mode-label">{l.label}</span>
                </span>
                {l.id === current ? <span className="mode-check">✓</span> : null}
              </button>
            ))}
            <div className="mode-foot-hint">
              低/中/高分别映射到 reasoning_effort（OpenAI 系）或 thinking 预算（Anthropic）；
              "默认"不传参数，服务端不支持时也不会报错。
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
