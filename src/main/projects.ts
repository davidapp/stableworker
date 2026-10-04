import { dialog, ipcMain } from 'electron'
import { basename, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadConfig, saveConfig } from './config'
import { deleteProjectSessions } from './sessions'
import type { ConfigView } from '../shared/types'

/**
 * 项目管理：项目 = 一个工作目录。
 * 与 Claude Code 一致，用规范化后的绝对路径做唯一键，同一目录不会出现两个条目；
 * 移除项目只移除配置与本地会话记录，不动磁盘上的项目文件。
 */

export function registerProjectHandlers(): void {
  ipcMain.handle('projects:add', async (): Promise<ConfigView | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择项目目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const path = normalize(result.filePaths[0])
    const cfg = await loadConfig()

    // 同一目录重复添加：只切换激活状态
    const existing = cfg.projects.find((p) => p.path === path)
    if (existing) {
      cfg.activeProjectId = existing.id
      return saveConfig(cfg)
    }

    cfg.projects.push({ id: randomUUID(), name: basename(path), path, createdAt: Date.now() })
    cfg.activeProjectId = cfg.projects[cfg.projects.length - 1].id
    return saveConfig(cfg)
  })

  ipcMain.handle('projects:setActive', async (_e, id: string): Promise<ConfigView> => {
    const cfg = await loadConfig()
    if (cfg.projects.some((p) => p.id === id)) cfg.activeProjectId = id
    return saveConfig(cfg)
  })

  ipcMain.handle('projects:remove', async (_e, id: string): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.projects = cfg.projects.filter((p) => p.id !== id)
    if (cfg.activeProjectId === id) cfg.activeProjectId = cfg.projects[0]?.id ?? null
    await deleteProjectSessions(id)
    return saveConfig(cfg)
  })
}
