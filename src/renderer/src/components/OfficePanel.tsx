import { useEffect, useRef, useState } from 'react'
import type { OfficeFile, OfficePreviewResult } from '../../../shared/types'
import { useApp } from '../store'
import { Icon } from './Icon'
import { t } from '../i18n'

function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The office task keeps imported material and generated deliverables together. */
export function OfficePanel({ onImport, onTask, refreshKey = 0, collapsed = false, onToggleCollapsed }: { onImport: () => void; onTask?: (text: string) => void; refreshKey?: number; collapsed?: boolean; onToggleCollapsed?: () => void }) {
  const { activeSessionId, messages, streaming } = useApp()
  const [files, setFiles] = useState<OfficeFile[]>([])
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ file: OfficeFile; result: OfficePreviewResult } | null>(null)
  const [loading, setLoading] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previewTrigger = useRef<HTMLButtonElement | null>(null)
  const finishedTools = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_use' && (b.status === 'done' || b.status === 'error')).map((b) => b.type === 'tool_use' ? `${b.id}:${b.status}:${b.rolledBack}` : '')).join('|')

  useEffect(() => {
    let current = true
    setPreview(null)
    setError('')
    if (!activeSessionId) { setFiles([]); return }
    void window.api.office.list(activeSessionId).then((list) => { if (current) setFiles(list) }).catch((err: unknown) => { if (current) setError(err instanceof Error ? err.message : String(err)) })
    return () => { current = false }
  }, [activeSessionId, finishedTools, refreshKey])

  useEffect(() => {
    if (!preview) return
    const previouslyFocused = previewTrigger.current ?? document.activeElement as HTMLElement | null
    const buttons = (): HTMLButtonElement[] => Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    buttons()[0]?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); setPreview(null) }
      if (event.key !== 'Tab') return
      const targets = buttons()
      if (!targets.length) return
      const index = targets.indexOf(document.activeElement as HTMLButtonElement)
      event.preventDefault()
      targets[(index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length]?.focus()
    }
    const focusin = (event: FocusEvent): void => {
      if (!dialogRef.current?.contains(event.target as Node)) buttons()[0]?.focus()
    }
    document.addEventListener('keydown', keydown)
    document.addEventListener('focusin', focusin)
    return () => {
      document.removeEventListener('keydown', keydown)
      document.removeEventListener('focusin', focusin)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [preview])

  const showPreview = async (file: OfficeFile, trigger: HTMLButtonElement): Promise<void> => {
    if (!activeSessionId || loading) return
    previewTrigger.current = trigger
    setLoading(true)
    try {
      const result = await window.api.office.preview(activeSessionId, file.path)
      setPreview({ file, result })
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setLoading(false) }
  }
  const open = async (file: OfficeFile): Promise<void> => {
    if (!activeSessionId) return
    try {
      const result = await window.api.office.open(activeSessionId, file.path)
      if (!result.ok) setError(result.error ?? '无法打开文件')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  if (collapsed) {
    return (
      <aside className="office-panel collapsed" aria-label={t('任务文件')}>
        <button
          className="icon-btn"
          title={t('展开任务文件面板')}
          aria-label={t('展开任务文件面板')}
          onClick={() => onToggleCollapsed?.()}
        >
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
        <Icon name="file" />
        <strong>{t('任务文件')}</strong>
        <span>{files.length}</span>
        <button
          className="icon-btn"
          title={t('收起任务文件面板')}
          aria-label={t('收起任务文件面板')}
          onClick={() => onToggleCollapsed?.()}
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      <p className="office-panel-intro">{t('导入资料，预览并打开生成的文件。')}</p>
      <button className="btn btn-block" disabled={streaming} onClick={onImport}><Icon name="attachment" /> {t('添加资料')}</button>
      {error && <p className="msg-error" role="alert">{error}</p>}
      {(['input', 'output'] as const).map((role) => {
        const group = files.filter((f) => f.role === role)
        return <section className="office-file-section" key={role}>
          <div className="sidebar-section-label">{role === 'input' ? t('参考资料') : t('生成结果')}<span>{group.length}</span></div>
          {group.length === 0 ? <p className="office-file-empty">{role === 'input' ? t('支持 Word、Excel、PPT、PDF 和文本') : t('完成后，文件会出现在这里')}</p> : group.map((file) => <div key={file.path} className="office-file-row">
            <button className="office-file-preview" title={`预览 ${file.name}`} disabled={loading} onClick={(e) => void showPreview(file, e.currentTarget)}><span className={`office-file-format format-${file.format}`}>{file.format.toUpperCase()}</span><span className="office-file-info"><strong>{file.name}</strong><small>{fileSize(file.size)}</small></span></button>
            <div className="office-file-actions">
              {['docx', 'pptx', 'xlsx'].includes(file.format) && <button className="icon-btn" title={`保留模板编辑 ${file.name}`} disabled={streaming} onClick={() => onTask?.(`请检查文件 ${file.path} 的可编辑位置，并在保留原模板样式和排版的前提下修改内容，另存为新副本。具体修改要求：`)}><Icon name="edit" size={14} /></button>}
              {file.format === 'xlsx' && <button className="icon-btn" title={`重算公式 ${file.name}`} disabled={streaming} onClick={() => onTask?.(`请在本地重算 ${file.path} 的公式，并保留原公式、格式与图表，另存为新的 Excel 文件。请报告未支持的公式或计算错误。`)}><Icon name="refresh" size={14} /></button>}
              {file.format === 'pdf' && <button className="icon-btn" title={`识别扫描文字 ${file.name}`} disabled={streaming} onClick={() => onTask?.(`请使用本地 OCR 提取 ${file.path} 中的中文和英文扫描文字，保留已有文字，遇到分页提示继续识别，并标明低置信度内容。`)}><Icon name="scan" size={14} /></button>}
              <button className="icon-btn" title={`打开 ${file.name}`} onClick={() => void open(file)}><Icon name="external" size={14} /></button>
            </div>
          </div>)}
        </section>
      })}
      {preview && <div className="office-preview-overlay" role="dialog" aria-modal="true" aria-label={`预览 ${preview.file.name}`}>
        <button className="office-preview-backdrop" aria-label="关闭预览" onClick={() => setPreview(null)} />
        <div className="office-preview-dialog" ref={dialogRef}>
          <header><Icon name="file" /><strong>{preview.file.name}</strong><div className="spacer" /><button className="btn" onClick={() => void open(preview.file)}><Icon name="external" /> 打开文件</button><button className="icon-btn" title="关闭预览" onClick={() => setPreview(null)}><Icon name="close" /></button></header>
          <p className="office-preview-note">内容预览 · 完整排版请打开文件查看</p>
          {preview.file.format === 'pdf' && <button className="btn office-preview-ocr" disabled={streaming} onClick={() => { onTask?.(`请用本地 OCR 提取 ${preview.file.path} 的扫描文字，并指出低置信度内容。`); setPreview(null) }}><Icon name="scan" /> 识别扫描文字</button>}
          {preview.result.ok ? <pre>{preview.result.content || '（文件没有可提取的文本）'}</pre> : <p className="msg-error">{preview.result.error}</p>}
        </div>
      </div>}
    </aside>
  )
}
