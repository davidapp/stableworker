import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp } from '../store'
import { t } from '../i18n'
import { Icon } from './Icon'

interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
}

/** 由扁平相对路径列表组树；目录在前、按名称排序 */
export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let cur = root
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = cur.children.find((c) => c.name === parts[i])
      if (!next) {
        next = { name: parts[i], path, children: [] }
        cur.children.push(next)
      }
      cur = next
    }
  }
  const sortRec = (node: TreeNode): void => {
    node.children.sort((a, b) => {
      const aIsDir = a.children.length > 0
      const bIsDir = b.children.length > 0
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const c of node.children) sortRec(c)
  }
  sortRec(root)
  return root.children
}

function TreeRow({ node, depth, onOpenFile }: { node: TreeNode; depth: number; onOpenFile: (path: string) => void }) {
  const isDir = node.children.length > 0
  const [open, setOpen] = useState(depth === 0)
  return (
    <div>
      <button
        className="filex-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        title={node.path}
        onClick={() => (isDir ? setOpen((v) => !v) : onOpenFile(node.path))}
      >
        <Icon name={isDir ? (open ? 'chevronDown' : 'chevronRight') : 'file'} size={12} />
        <span>{node.name}</span>
      </button>
      {isDir && open ? node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} onOpenFile={onOpenFile} />) : null}
    </div>
  )
}

/** 文件面板（编程模式）：浏览工作目录文件树，点击文件预览内容；头部可打开目录、收起面板 */
export function FileExplorerPanel({ collapsed = false, onToggleCollapsed }: { collapsed?: boolean; onToggleCollapsed?: () => void }) {
  const { activeProjectId } = useApp()
  const [paths, setPaths] = useState<string[]>([])
  const [viewPath, setViewPath] = useState<string | null>(null)
  const [viewContent, setViewContent] = useState<string>('')
  const [viewTruncated, setViewTruncated] = useState(false)
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!activeProjectId) {
      setPaths([])
      return
    }
    setPaths(await window.api.getProjectFiles(activeProjectId))
  }, [activeProjectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const tree = useMemo(() => buildTree(paths), [paths])

  const openFile = async (path: string): Promise<void> => {
    if (!activeProjectId) return
    const r = await window.api.readMentions(activeProjectId, [path])
    const hit = r[0]
    setViewPath(path)
    setViewContent(hit?.content ?? `（无法读取：${hit?.missing ? '文件不存在' : '读取失败'}）`)
    setViewTruncated(hit?.truncated === true)
  }

  if (collapsed) {
    return (
      <aside className="filex-panel collapsed" aria-label={t('文件')}>
        <button className="icon-btn" title={t('展开文件面板')} aria-label={t('展开文件面板')} onClick={() => onToggleCollapsed?.()}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <button className="icon-btn" title={t('文件')} aria-label={t('文件')} onClick={() => onToggleCollapsed?.()}>
          <Icon name="file" size={16} />
        </button>
        <span className="office-panel-count">{paths.length}</span>
      </aside>
    )
  }

  return (
    <aside className="filex-panel" aria-label={t('文件')}>
      <div className="office-panel-heading">
        <Icon name="folder" />
        <strong>{t('文件')}</strong>
        <span>{paths.length}</span>
        <button
          className="icon-btn"
          title={t('在资源管理器中打开工作目录')}
          aria-label={t('在资源管理器中打开工作目录')}
          onClick={() => {
            if (!activeProjectId) return
            void window.api.openInExplorer(activeProjectId).then((r) => {
              if (!r.ok) setNotice(r.error ?? '打开失败')
            })
          }}
        >
          <Icon name="external" size={13} />
        </button>
        <button
          className="icon-btn"
          title={t('收起文件面板')}
          aria-label={t('收起文件面板')}
          onClick={() => onToggleCollapsed?.()}
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      {notice ? <div className="office-file-empty">{notice}</div> : null}
      <div className="filex-tree">
        {tree.length === 0 ? (
          <div className="office-file-empty">{t('目录为空')}</div>
        ) : (
          tree.map((n) => <TreeRow key={n.path} node={n} depth={0} onOpenFile={(p) => void openFile(p)} />)
        )}
      </div>

      {viewPath ? (
        <>
          <div className="popover-backdrop" onClick={() => setViewPath(null)} />
          <div className="filex-viewer" role="dialog" aria-label={`${t('文件预览')}: ${viewPath}`}>
            <div className="filex-viewer-head">
              <code>{viewPath}</code>
              <div className="spacer" />
              <button
                className="btn"
                onClick={() => activeProjectId && void window.api.openInExplorer(activeProjectId, viewPath)}
              >
                {t('在资源管理器中显示')}
              </button>
              <button className="icon-btn" aria-label={t('关闭')} onClick={() => setViewPath(null)}>
                <Icon name="close" size={14} />
              </button>
            </div>
            {viewTruncated ? <div className="hint-line">{t('内容过长，仅显示前一部分')}</div> : null}
            <pre className="filex-viewer-body">{viewContent}</pre>
          </div>
        </>
      ) : null}
    </aside>
  )
}
