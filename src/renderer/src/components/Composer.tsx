import { useEffect, useRef, useState } from 'react'
import type { OfficeFile } from '../../../shared/types'
import { useApp } from '../store'
import * as actions from '../actions'
import { ApprovalModeMenu } from './ApprovalModeMenu'
import { ThinkingEffortMenu } from './ThinkingEffortMenu'
import { ContextMeter } from './ContextMeter'
import { CaretIcon } from './CaretIcon'
import { Icon } from './Icon'
import { t } from '../i18n'

export function Composer({ disabled, attachments = [], onAttach, onRemove, onSend, taskDraft }: { disabled: boolean; attachments?: Array<Pick<OfficeFile, 'path' | 'name' | 'size'>>; onAttach?: () => void; onRemove?: (path: string) => void; onSend?: (text: string) => void; taskDraft?: { id: number; text: string } | null }) {
  const { llmProfiles, activeLlmId, activeSessionId, taskMode, activeProjectId, sessionsByProject } = useApp()
  const office = taskMode === 'office'
  const video = taskMode === 'video'
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // @文件引用补全：光标处于 @片段 中时显示项目文件候选
  const [mention, setMention] = useState<{ start: number; query: string; items: string[]; active: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // 本会话独立选择的模型（会话 meta.llmId）；未选择时跟随全局激活档
  const sessionLlmId = activeSessionId && activeProjectId
    ? sessionsByProject[activeProjectId]?.find((m) => m.id === activeSessionId)?.llmId
    : undefined
  // 会话覆盖的配置档若已被停用/删除，则回退全局激活档，再回退第一个启用档
  const sessionProfile = sessionLlmId ? llmProfiles.find((p) => p.id === sessionLlmId) : undefined
  const currentProfile =
    sessionProfile && sessionProfile.enabled !== false
      ? sessionProfile
      : llmProfiles.find((p) => p.id === activeLlmId && p.enabled !== false) ??
        llmProfiles.find((p) => p.enabled !== false)
  const currentLlmId = currentProfile?.id
  useEffect(() => { setText(''); setMention(null) }, [activeSessionId, taskMode])
  useEffect(() => {
    if (!taskDraft) return
    setText((previous) => previous.trim() ? `${previous}\n\n${taskDraft.text}` : taskDraft.text)
    textareaRef.current?.focus()
  }, [taskDraft])

  const refreshMention = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(before)
    if (!m || !activeProjectId) {
      setMention(null)
      return
    }
    const start = caret - m[2].length - 1
    setMention({ start, query: m[2], items: [], active: 0 })
    void window.api.completeFiles(activeProjectId, m[2]).then((items) => {
      setMention((prev) => (prev && prev.start === start ? { ...prev, items } : prev))
    })
  }

  const applyMention = (path: string): void => {
    if (!mention) return
    const ta = textareaRef.current
    const caret = ta?.selectionStart ?? mention.start + mention.query.length + 1
    const next = text.slice(0, mention.start) + '@' + path + ' ' + text.slice(caret)
    setText(next)
    setMention(null)
    requestAnimationFrame(() => {
      ta?.focus()
      const pos = mention.start + path.length + 2
      ta?.setSelectionRange(pos, pos)
    })
  }

  const submit = (): void => {
    const content = text.trim()
    if ((!content && attachments.length === 0) || disabled) return
    setText('')
    setMention(null)
    if (onSend) onSend(content || t('请阅读这些资料，并整理主要内容。'))
    else void actions.sendChat(content)
  }

  return (
    <footer className="composer">
      <div className="composer-box" style={{ position: 'relative' }}>
        {(office || video) && attachments.length > 0 && <div className="office-attachment-chips">{attachments.map((file) => <span key={file.path}><Icon name="attachment" size={12} /><span title={file.name}>{file.name}</span><button className="icon-btn" aria-label={`移除附件 ${file.name}`} onClick={() => onRemove?.(file.path)}><Icon name="close" size={12} /></button></span>)}</div>}
        {mention && mention.items.length > 0 ? (
          <div
            role="listbox"
            aria-label="文件引用候选"
            style={{ position: 'absolute', left: 10, right: 10, bottom: 'calc(100% - 8px)', zIndex: 20, maxHeight: 200, overflowY: 'auto', background: 'var(--bg-elevated, #1b1d22)', border: '1px solid var(--border, #2c2f36)', borderRadius: 10, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
          >
            {mention.items.map((p, i) => (
              <button
                key={p}
                role="option"
                aria-selected={i === mention.active}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px', borderRadius: 6, fontSize: 12, background: i === mention.active ? 'var(--bg-hover, #26292f)' : 'transparent', color: 'inherit', border: 'none', cursor: 'pointer' }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  applyMention(p)
                }}
                onMouseEnter={() => setMention({ ...mention, active: i })}
              >
                {p}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          aria-label="消息"
          value={text}
          placeholder={office ? t('描述要完成的工作，或添加资料开始') : video ? t('描述视频主题，或添加图片素材开始') : t('输入消息，@ 引用项目文件，Enter 发送，Shift+Enter 换行')}
          rows={2}
          onChange={(e) => {
            setText(e.target.value)
            refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }}
          onKeyDown={(e) => {
            // isComposing：中文输入法选词时的 Enter 不应当作发送
            if (e.nativeEvent.isComposing) return
            if (mention && mention.items.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setMention({ ...mention, active: (mention.active + 1) % mention.items.length })
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setMention({ ...mention, active: (mention.active - 1 + mention.items.length) % mention.items.length })
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                applyMention(mention.items[mention.active])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMention(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-row">
          {(office || video) && <button className="icon-btn-lg icon-btn-square" title={office ? t('添加办公资料') : t('添加视频素材')} disabled={disabled} onClick={onAttach}><Icon name="attachment" /></button>}
          <ApprovalModeMenu />
          <div className="spacer" />
          <ContextMeter />
          <div className="model-select-wrap">
            {menuOpen ? <div className="popover-backdrop" onClick={() => setMenuOpen(false)} /> : null}
            <button
              className="model-select"
              title="切换本会话使用的模型（仅当前会话生效）"
              onClick={() => setMenuOpen((v) => !v)}
            >
              {currentProfile?.model || t('未配置模型')}
              <CaretIcon />
            </button>
            {menuOpen ? (
              <div className="mode-menu model-menu">
                {llmProfiles.length === 0 ? (
                  <div className="mode-item">{t('未配置模型')}</div>
                ) : (
                  llmProfiles.filter((p) => p.enabled !== false).map((p) => (
                    <button
                      key={p.id}
                      className="mode-item"
                      style={p.id === currentLlmId ? { color: 'var(--accent-strong)' } : undefined}
                      onClick={() => {
                        setMenuOpen(false)
                        void actions.setSessionModel(p.id)
                      }}
                    >
                      <span style={{ flex: 1, textAlign: 'left' }}>{p.model || p.name}</span>
                      {p.id === currentLlmId ? '✓' : ''}
                    </button>
                  ))
                )}
                <div className="model-menu-divider" />
                <button
                  className="mode-item"
                  onClick={() => {
                    setMenuOpen(false)
                    actions.openSettings('llm')
                  }}
                >
                  ⚙ {t('管理模型…')}
                </button>
              </div>
            ) : null}
          </div>
          <ThinkingEffortMenu />
        {disabled ? (
          <button className="composer-send stop" title={t('停止生成')} onClick={() => void actions.stopChat()}>
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
    </footer>
  )
}
