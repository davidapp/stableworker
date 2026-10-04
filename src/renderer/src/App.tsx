import { useEffect, useRef } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useApp, store } from './store'
import * as actions from './actions'
import { Sidebar } from './components/Sidebar'
import { ChatPane } from './components/ChatPane'
import { SettingsDialog } from './components/SettingsDialog'

const MIN_SIDEBAR = 180
const MAX_SIDEBAR = 480

export default function App() {
  const { booted, settingsOpen, sidebarWidth } = useApp()
  const draggingRef = useRef(false)

  useEffect(() => {
    void actions.boot()
    return actions.subscribeChatEvents()
  }, [])

  if (!booted) {
    return <div className="boot">正在加载…</div>
  }

  // 拖拽分隔条：实时更新宽度，松手时持久化
  const onSplitterDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }
  const onSplitterMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    const width = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, e.clientX))
    store.setState({ sidebarWidth: width })
  }
  const onSplitterUp = (): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    void actions.setSidebarWidth(store.getState().sidebarWidth)
  }

  return (
    <div className="app" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      <Sidebar />
      <div
        className="splitter"
        title="拖拽调整侧栏宽度"
        onPointerDown={onSplitterDown}
        onPointerMove={onSplitterMove}
        onPointerUp={onSplitterUp}
      />
      <ChatPane />
      {/* 用条件挂载保证每次打开时都基于最新数据初始化 */}
      {settingsOpen && <SettingsDialog />}
    </div>
  )
}
