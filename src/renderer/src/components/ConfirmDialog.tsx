import { useApp } from '../store'
import * as actions from '../actions'
import { Icon } from './Icon'

/**
 * 全局确认/信息对话框（替代原生 window.confirm / window.alert 的应用皮肤版本）。
 * 组件挂在 App 根部；调用方使用 actions.confirm(message, { danger }) 与 actions.alert(message)。
 * tone: normal = 确认操作（取消/确定），danger = 危险操作（确定按钮红色），info = 仅信息（单确定）。
 */
export function ConfirmDialog() {
  const state = useApp().confirmState
  if (!state) return null
  const isInfo = state.tone === 'info'
  return (
    <div className="modal-overlay" onClick={() => actions.resolveConfirm(isInfo)}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog-title">
          <Icon name={state.tone === 'danger' ? 'warning' : isInfo ? 'check' : 'question'} size={16} />
          {state.tone === 'danger' ? '危险操作确认' : isInfo ? '提示' : '确认操作'}
        </div>
        <div className="confirm-dialog-message">{state.message}</div>
        <div className="confirm-dialog-actions">
          {!isInfo ? (
            <button className="btn" autoFocus onClick={() => actions.resolveConfirm(false)}>
              取消
            </button>
          ) : null}
          <button
            className={`btn ${state.tone === 'danger' ? 'btn-danger-ghost' : 'btn-primary'}`}
            autoFocus={isInfo}
            onClick={() => actions.resolveConfirm(true)}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
