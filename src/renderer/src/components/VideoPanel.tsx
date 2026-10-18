import { useEffect, useState } from 'react'
import type { VideoFile } from '../../../shared/types'
import { useApp } from '../store'
import { Icon } from './Icon'
import { t } from '../i18n'

function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** 语义分组：配音是中间产物不算成品；mp4 才是成品 */
function groupOf(path: string): 'material' | 'voice' | 'product' | 'work' {
  if (path.startsWith('inputs/')) return 'material'
  if (/^outputs\/voice-\d+\.mp3$/.test(path)) return 'voice'
  if (path.startsWith('outputs/') && path.endsWith('.mp4')) return 'product'
  return 'work'
}

const GROUPS = [
  { key: 'material', label: '素材', empty: '支持图片与音频' },
  { key: 'voice', label: '配音', empty: '旁白配音会出现在这里' },
  { key: 'product', label: '成品', empty: '合成完成后，视频会出现在这里' },
  { key: 'work', label: '中间文件', empty: '' },
] as const

/** 视频任务的素材与产物面板：inputs/（导入的图片、音频）与 outputs/（配音、成品 MP4） */
export function VideoPanel({ onImport, refreshKey = 0, collapsed = false, onToggleCollapsed }: { onImport: () => void; refreshKey?: number; collapsed?: boolean; onToggleCollapsed?: () => void }) {
  const { activeSessionId, messages, streaming } = useApp()
  const [files, setFiles] = useState<VideoFile[]>([])
  const [error, setError] = useState('')
  const finishedTools = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_use' && (b.status === 'done' || b.status === 'error')).map((b) => b.type === 'tool_use' ? `${b.id}:${b.status}` : '')).join('|')

  useEffect(() => {
    let current = true
    setError('')
    if (!activeSessionId) { setFiles([]); return }
    void window.api.video.list(activeSessionId).then((list) => { if (current) setFiles(list) }).catch((err: unknown) => { if (current) setError(err instanceof Error ? err.message : String(err)) })
    return () => { current = false }
  }, [activeSessionId, finishedTools, refreshKey])

  const open = async (file: VideoFile): Promise<void> => {
    if (!activeSessionId) return
    try {
      const result = await window.api.video.open(activeSessionId, file.path)
      if (!result.ok) setError(result.error ?? '无法打开文件')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  if (collapsed) {
    return (
      <aside className="office-panel collapsed" aria-label={t('任务文件')}>
        <button className="icon-btn" title={t('展开任务文件面板')} aria-label={t('展开任务文件面板')} onClick={() => onToggleCollapsed?.()}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <button className="icon-btn" title={t('任务文件')} aria-label={t('任务文件')} onClick={() => onToggleCollapsed?.()}>
          <Icon name="file" size={16} />
        </button>
        <span className="office-panel-count">{files.length}</span>
      </aside>
    )
  }

  return (
    <aside className="office-panel" aria-label={t('任务文件')}>
      <div className="office-panel-heading">
        <Icon name="video" />
        <strong>{t('任务文件')}</strong>
        <span>{files.length}</span>
        <button className="icon-btn" title={t('收起任务文件面板')} aria-label={t('收起任务文件面板')} onClick={() => onToggleCollapsed?.()}>
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      <p className="office-panel-intro">{t('导入图片/音频素材，配音与成片会出现在这里。')}</p>
      <button className="btn btn-block" disabled={streaming} onClick={onImport}><Icon name="attachment" /> {t('添加素材')}</button>
      {error && <p className="msg-error" role="alert">{error}</p>}
      {GROUPS.map(({ key, label, empty }) => {
        const group = files.filter((f) => groupOf(f.path) === key)
        return <section className="office-file-section" key={key}>
          <div className="sidebar-section-label">{t(label)}<span>{group.length}</span></div>
          {group.length === 0 ? (empty ? <p className="office-file-empty">{t(empty)}</p> : null) : group.map((file) => <div key={file.path} className="office-file-row">
            <span className="office-file-info"><strong>{baseName(file.path)}</strong><small>{fileSize(file.bytes)}</small></span>
            <div className="office-file-actions">
              <button className="icon-btn" title={`打开 ${baseName(file.path)}`} onClick={() => void open(file)}><Icon name="external" size={14} /></button>
            </div>
          </div>)}
        </section>
      })}
    </aside>
  )
}
