import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

let initialized = false
let checking = false
let downloaded = false
let promptingToInstall = false

async function promptToInstall(): Promise<void> {
  if (promptingToInstall) return
  promptingToInstall = true
  try {
    const r = await dialog.showMessageBox({
      type: 'info',
      title: '更新已就绪',
      message: '更新已下载完成，重启应用以安装？',
      detail: '选择稍后会在退出应用时安装。重启前请等待正在运行的任务完成。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 1,
      cancelId: 1,
    })
    if (r.response === 0) autoUpdater.quitAndInstall(false, true)
  } finally {
    promptingToInstall = false
  }
}

/** 打包版通过 GitHub Releases 更新；由 electron-updater 判断版本、系统及灰度资格。 */
export function setupUpdater(): void {
  if (!app.isPackaged || initialized) return
  initialized = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false

  autoUpdater.on('update-downloaded', () => {
    downloaded = true
    // EventEmitter 不会等待异步监听器；处理拒绝以免产生未捕获的 Promise。
    void promptToInstall().catch((err) => console.error('[updater]', err))
  })
  autoUpdater.on('error', (err) => console.error('[updater]', err.message))
}

export async function checkForUpdatesDialog(): Promise<void> {
  if (checking) return
  checking = true
  try {
    if (!app.isPackaged) {
      await dialog.showMessageBox({ type: 'info', message: '开发模式不支持更新检查' })
      return
    }
    if (process.platform === 'linux' && !process.env.APPIMAGE) {
      await dialog.showMessageBox({ type: 'info', message: '请从 AppImage 启动应用后检查更新' })
      return
    }
    setupUpdater()
    if (downloaded) {
      await promptToInstall()
      return
    }
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      await dialog.showMessageBox({ type: 'info', message: '当前安装方式不支持自动更新，请前往 GitHub Releases 下载新版本' })
      return
    }
    if (!result.isUpdateAvailable) {
      await dialog.showMessageBox({ type: 'info', message: `当前没有可用更新（v${app.getVersion()}）` })
      return
    }
    const answer = await dialog.showMessageBox({
      type: 'info',
      message: `发现新版本 v${result.updateInfo.version}（当前 v${app.getVersion()}），是否下载？`,
      buttons: ['下载更新', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if (answer.response === 0) await autoUpdater.downloadUpdate()
    // 下载完成由 update-downloaded 事件提示安装。
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      message: '更新失败：' + (err instanceof Error ? err.message : String(err)),
    })
  } finally {
    checking = false
  }
}
