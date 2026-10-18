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

function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i < 0 ? '' : path.slice(i + 1).toLowerCase()
}

const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'])

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

/** 视频任务的素材与产物面板：inputs/（导入素材）与 outputs/（配音、成品 MP4），音频可点击播放 */
export function VideoPanel({ onImport, refreshKey = 0, collapsed = false, onToggleCollapsed }: { onImport: () => void; refreshKey?: number; collapsed?: boolean; onToggleCollapsed?: () => void }) {
  const { activeSessionId, messages, streaming } = useApp()
  const [files, setFiles] = useState<VideoFile[]>([])
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
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

  const togglePlay = (file: VideoFile): void => {
    setPlaying((current) => (current === file.path ? null : file.path))
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
          {group.length === 0 ? (empty ? <p className="office-file-empty">{t(empty)}</p> : null) : group.map((file) => {
            const ext = extOf(file.path)
            const isAudio = AUDIO_EXTS.has(ext)
            const isPlaying = playing === file.path
            return (
              <div key={file.path}>
                <div className="office-file-row">
                  <button className="office-file-preview" title={isAudio ? t('点击播放') : baseName(file.path)} onClick={() => (isAudio ? togglePlay(file) : void open(file))}>
                    <span className="office-file-format">{ext.toUpperCase()}</span>
                    <span className="office-file-info">
                      <strong>{baseName(file.path)}</strong>
                      <small>{isAudio ? (isPlaying ? t('正在播放') : t('点击播放')) : fileSize(file.bytes)}</small>
                    </span>
                  </button>
                  <div className="office-file-actions">
                    {isAudio && (
                      <button className="icon-btn" title={isPlaying ? t('暂停') : t('播放')} onClick={() => togglePlay(file)}>
                        <Icon name={isPlaying ? 'stop' : 'play'} size={14} />
                      </button>
                    )}
                    <button className="icon-btn" title={`打开 ${baseName(file.path)}`} onClick={() => void open(file)}><Icon name="external" size={14} /></button>
                  </div>
                </div>
                {isPlaying && activeSessionId && (
                  <audio
                    className="video-audio"
                    controls
                    autoPlay
                    src={`video-media://${activeSessionId}/${file.path}`}
                  />
                )}
              </div>
            )
          })}
        </section>
      })}
    </aside>
  )
}
