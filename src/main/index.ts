import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerConfigHandlers } from './config'
import { registerProjectHandlers } from './projects'
import { registerSessionHandlers } from './sessions'
import { registerChatHandlers } from './llm'
import { registerDebugHandlers, initDebugLog } from './debug'
import { registerApprovalHandlers } from './approvals'
import { openInspectorWindow } from './inspectorWindow'
import { createAppMenu } from './menu'

/**
 * 主进程入口：创建窗口、注册所有 IPC 处理器。
 * 架构约定：
 * - 渲染进程不碰 Node/Electron API，一切能力通过 preload 暴露的 window.api 走 IPC
 * - 每个能力域一个模块（config / projects / sessions / llm），各自注册自己的 ipcMain.handle
 */

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'StableWorker',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Electron 安全基线：上下文隔离 + 关闭 Node 集成 + 沙箱
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 界面标题固定，防止页面 title 改掉窗口标题
  win.on('page-title-updated', (e) => e.preventDefault())

  // 外部链接一律交给系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Markdown 里的链接被点击时不在应用内跳转，交给系统浏览器
  win.webContents.on('will-navigate', (event, url) => {
    const isInternal = app.isPackaged
      ? url.startsWith('file://')
      : url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173')
    if (!isInternal) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // 开发模式下 electron-vite 会注入 renderer 的 dev server 地址
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  registerConfigHandlers()
  registerProjectHandlers()
  registerSessionHandlers()
  registerChatHandlers()
  registerDebugHandlers()
  registerApprovalHandlers()
  await initDebugLog() // 启动时从磁盘恢复历史 API 调用记录
  createAppMenu(() => openInspectorWindow())
  createWindow()

  // macOS：点 Dock 图标时如果没有窗口则重新创建
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 非 macOS：关掉所有窗口就退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
