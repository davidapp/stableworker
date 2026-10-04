import { BrowserWindow, app, ipcMain } from 'electron'
import { join } from 'node:path'

/**
 * API 调试的独立悬浮窗口：与主窗口共享同一套渲染代码，
 * 通过 URL 参数 ?page=inspector 让入口只渲染调试面板。
 * alwaysOnTop 让它悬浮在主窗口之上，方便边对话边观察协议细节。
 */

let inspectorWin: BrowserWindow | null = null

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

export function registerInspectorHandlers(): void {
  // 渲染进程（如侧栏小图标）请求打开调试窗口
  ipcMain.handle('inspector:open', () => openInspectorWindow())
}
