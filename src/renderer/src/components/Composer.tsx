import { useState } from 'react'
import * as actions from '../actions'

export function Composer({ disabled }: { disabled: boolean }) {
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
        {disabled ? <span className="composer-hint">回复生成中…</span> : null}
        {disabled ? (
          <button className="composer-send stop" title="停止生成" onClick={() => void actions.stopChat()}>
            ■
          </button>
        ) : (
          <button
            className="composer-send"
            title="发送（Enter）"
            disabled={!text.trim()}
            onClick={submit}
          >
            ↑
          </button>
        )}
      </div>
    </footer>
  )
}
