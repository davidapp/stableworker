import { useEffect } from 'react'
import { useApp } from './store'
import * as actions from './actions'
import { Sidebar } from './components/Sidebar'
import { ChatPane } from './components/ChatPane'
import { SettingsDialog } from './components/SettingsDialog'

export default function App() {
  const { booted, settingsOpen } = useApp()

  useEffect(() => {
    void actions.boot()
    return actions.subscribeChatEvents()
  }, [])

  if (!booted) {
    return <div className="boot">正在加载…</div>
  }

  return (
    <div className="app">
      <Sidebar />
      <ChatPane />
      {/* 用条件挂载保证每次打开设置时表单都基于最新配置初始化 */}
      {settingsOpen && <SettingsDialog />}
    </div>
  )
}
