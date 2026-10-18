import { dialog, ipcMain } from 'electron'
import { basename, normalize, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { lstat, stat } from 'node:fs/promises'
import { loadConfig, saveConfig } from './config'
import { deleteProjectSessions } from './sessions'
import type { ConfigView } from '../shared/types'

/**
 * 项目管理：项目 = 一个工作目录。
 * 与 Claude Code 一致，用规范化后的绝对路径做唯一键，同一目录不会出现两个条目；
 * 移除项目只移除配置与本地会话记录，不动磁盘上的项目文件。
 */

export interface ContextFilePick {
  /** 项目内相对路径（正斜杠），供消息引用与 read_file 使用 */
  path: string
  name: string
  size: number
}

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

  ipcMain.handle('projects:rename', async (_e, id: string, name: string): Promise<ConfigView> => {
    const cfg = await loadConfig()
    const target = cfg.projects.find((p) => p.id === id)
    const clean = name.trim()
    if (target && clean) target.name = clean
    return saveConfig(cfg)
  })

  ipcMain.handle('projects:remove', async (_e, id: string): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.projects = cfg.projects.filter((p) => p.id !== id)
    if (cfg.activeProjectId === id) cfg.activeProjectId = cfg.projects[0]?.id ?? null
    await deleteProjectSessions(id)
    return saveConfig(cfg)
  })

  // 编程模式"添加上下文"：在项目目录内选文件，返回相对路径供消息引用
  ipcMain.handle('projects:pickContextFiles', async (_e, id: string): Promise<ContextFilePick[]> => {
    const cfg = await loadConfig()
    const project = cfg.projects.find((p) => p.id === id)
    if (!project) throw new Error('项目不存在')
    const selected = await dialog.showOpenDialog({
      title: '添加上下文文件',
      defaultPath: project.path,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
    })
    if (selected.canceled || selected.filePaths.length === 0) return []
    const picks: ContextFilePick[] = []
    for (const abs of selected.filePaths) {
      const root = resolve(project.path)
      const normalized = resolve(abs)
      if (normalized !== root && !normalized.startsWith(root + sep)) throw new Error('只能添加项目目录内的文件')
      const info = await lstat(normalized)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('只能添加普通文件')
      const size = (await stat(normalized)).size
      const rel = relative(root, normalized).split(sep).join('/')
      picks.push({ path: rel, name: basename(normalized), size })
      if (picks.length >= 20) break
    }
    return picks
  })
}
