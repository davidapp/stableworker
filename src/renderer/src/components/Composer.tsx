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
      <div className="composer-actions">
        <span className="hint">{disabled ? '回复生成中…' : ''}</span>
        {disabled ? (
          <button className="btn btn-danger" onClick={() => void actions.stopChat()}>
            ■ 停止
          </button>
        ) : (
          <button className="btn btn-primary" disabled={!text.trim()} onClick={submit}>
            发送
          </button>
        )}
      </div>
    </footer>
  )
}
