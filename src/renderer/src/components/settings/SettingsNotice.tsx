import { Icon } from '../Icon'

export interface SettingsNoticeValue {
  tone: 'success' | 'error' | 'warning'
  text: string
}

export function SettingsNotice({ notice }: { notice: SettingsNoticeValue | null }) {
  if (!notice) return null
  return (
    <span className={`status-line status-${notice.tone}`} role="status">
      <Icon name={notice.tone === 'success' ? 'check' : 'warning'} size={14} />
      {notice.text}
    </span>
  )
}
