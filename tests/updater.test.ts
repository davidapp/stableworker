import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '0.9.0' },
  dialog: { showMessageBox: vi.fn() },
  updater: {
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
    autoDownload: true, autoInstallOnAppQuit: false, allowDowngrade: true, allowPrerelease: true,
  },
}))
vi.mock('electron', () => ({ app: mocks.app, dialog: mocks.dialog }))
vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('APPIMAGE', '/tmp/StableWorker.AppImage')
  mocks.app.isPackaged = true
  mocks.dialog.showMessageBox.mockResolvedValue({ response: 1 })
  mocks.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '0.10.0' } })
  mocks.updater.downloadUpdate.mockResolvedValue([])
})

describe('update decisions', () => {
  it.each(['0.9.0', '0.8.0', '0.10.0'])('does not download %s when the updater rejects eligibility', async (version) => {
    mocks.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version } })
    const { checkForUpdatesDialog } = await import('../src/main/updater')
    await checkForUpdatesDialog()
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('没有可用更新') }))
  })

  it('downloads only after confirmation and allows cancellation', async () => {
    const { checkForUpdatesDialog } = await import('../src/main/updater')
    await checkForUpdatesDialog()
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await checkForUpdatesDialog()
    expect(mocks.updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ cancelId: 1, buttons: ['下载更新', '取消'] }))
  })

  it('coalesces concurrent checks and unlocks after a failed check', async () => {
    let reject!: (error: Error) => void
    mocks.updater.checkForUpdates.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
    const { checkForUpdatesDialog } = await import('../src/main/updater')
    const first = checkForUpdatesDialog()
    await checkForUpdatesDialog()
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1)
    reject(new Error('offline'))
    await first
    await checkForUpdatesDialog()
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: '更新失败：offline' }))
  })

  it('reports a disabled updater instead of claiming to be current', async () => {
    mocks.updater.checkForUpdates.mockResolvedValue(null)
    const { checkForUpdatesDialog } = await import('../src/main/updater')
    await checkForUpdatesDialog()
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('不支持自动更新') }))
  })

  it('does not check in development', async () => {
    mocks.app.isPackaged = false
    const { checkForUpdatesDialog } = await import('../src/main/updater')
    await checkForUpdatesDialog()
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('surfaces download failures and permits retry', async () => {
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    mocks.updater.downloadUpdate.mockRejectedValueOnce(new Error('checksum mismatch'))
    const { checkForUpdatesDialog } = await import('../src/main/updater')
    await checkForUpdatesDialog()
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: '更新失败：checksum mismatch' }))
    await checkForUpdatesDialog()
    expect(mocks.updater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('registers once, keeps stable upgrades, and reuses a downloaded update', async () => {
    const { setupUpdater, checkForUpdatesDialog } = await import('../src/main/updater')
    setupUpdater()
    setupUpdater()
    expect(mocks.updater.on).toHaveBeenCalledTimes(2)
    expect(mocks.updater).toMatchObject({ autoDownload: false, allowDowngrade: false, allowPrerelease: false, autoInstallOnAppQuit: true })
    const listener = mocks.updater.on.mock.calls.find(([event]) => event === 'update-downloaded')![1]
    listener()
    await vi.waitFor(() => expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(1))
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ defaultId: 1, cancelId: 1 }))
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await checkForUpdatesDialog()
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
})
