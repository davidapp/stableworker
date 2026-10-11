import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * 自动更新（electron-updater + GitHub Releases）。
 * - 仅打包版启用；开发模式弹窗提示不支持
 * - autoDownload=false：检查到新版本后询问下载，下载完成询问重启安装
 * - 更新源：package.json 的 repository → GitHub Releases（build.yml 已上传 latest.yml 等元数据）
 */

export function setupUpdater(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', async () => {
    const r = await dialog.showMessageBox({
      type: 'info',
      title: '更新已就绪',
      message: '更新已下载完成，重启应用以安装？',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
    })
    if (r.response === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', (err) => {
    // 静默记录：更新失败不打断使用（菜单手动检查时有独立提示）
    console.error('[updater]', err.message)
  })
}

export async function checkForUpdatesDialog(): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox({ type: 'info', message: '开发模式不支持更新检查' })
    return
  }
  try {
    await dialog.showMessageBox({ type: 'info', message: '正在检查更新…' })
    const r = await autoUpdater.checkForUpdates()
    const v = r?.updateInfo?.version
    if (v && v !== app.getVersion()) {
      await dialog.showMessageBox({
        type: 'info',
        message: `发现新版本 v${v}（当前 v${app.getVersion()}），正在后台下载…`,
      })
      await autoUpdater.downloadUpdate()
      // 下载完成由 update-downloaded 事件弹窗
    } else {
      await dialog.showMessageBox({ type: 'info', message: `已是最新版本（v${app.getVersion()}）` })
    }
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      message: '检查更新失败：' + (err instanceof Error ? err.message : String(err)),
    })
  }
}
