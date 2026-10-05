import { BrowserWindow, app, ipcMain } from 'electron'
import { join } from 'node:path'

/**
 * API 调试的独立悬浮窗口：与主窗口共享同一套渲染代码，
 * 通过 URL 参数 ?page=inspector 让入口只渲染调试面板。
 * alwaysOnTop 让它悬浮在主窗口之上，方便边对话边观察协议细节。
 */

let inspectorWin: BrowserWindow | null = null
let contextWin: BrowserWindow | null = null

export function openInspectorWindow(): void {
  if (inspectorWin && !inspectorWin.isDestroyed()) {
    inspectorWin.focus()
    return
  }
  inspectorWin = new BrowserWindow({
    width: 1020,
    height: 680,
    title: 'API 调试',
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  inspectorWin.setAlwaysOnTop(true, 'floating')
  inspectorWin.on('closed', () => {
    inspectorWin = null
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void inspectorWin.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/?page=inspector`)
  } else {
    void inspectorWin.loadFile(join(__dirname, '../renderer/index.html'), { query: { page: 'inspector' } })
  }
}

/** 上下文管理独立悬浮窗口（?page=context 只渲染会话内容管理页） */
export function openContextWindow(): void {
  if (contextWin && !contextWin.isDestroyed()) {
    contextWin.focus()
    return
  }
  contextWin = new BrowserWindow({
    width: 760,
    height: 720,
    title: '上下文管理',
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  contextWin.setAlwaysOnTop(true, 'floating')
  contextWin.on('closed', () => {
    contextWin = null
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void contextWin.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/?page=context`)
  } else {
    void contextWin.loadFile(join(__dirname, '../renderer/index.html'), { query: { page: 'context' } })
  }
}

export function registerInspectorHandlers(): void {
  // 渲染进程（如侧栏小图标）请求打开调试窗口
  ipcMain.handle('inspector:open', () => openInspectorWindow())
  // 渲染进程请求打开上下文管理窗口
  ipcMain.handle('context:open', () => openContextWindow())
}
