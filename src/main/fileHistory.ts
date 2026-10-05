import { app, ipcMain } from 'electron'
import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { safeResolve } from './tools/paths'
import { loadConfig } from './config'

/**
 * 文件检查点（回滚）：write_file / edit_file 执行前把目标文件快照到
 * userData/checkpoints/<projectId>/<sessionId>/<toolUseId>/，
 * 之后可随时恢复到"本次修改之前"的状态。
 *
 * - 快照粒度 = 单次工具调用（toolUseId），只备份即将被改的那几个文件，成本极低
 * - 回滚前先把当前状态也拍一份（restore-<ts> 快照），回滚本身可再回滚
 * - 滚动上限：每会话最多 100 份快照，超出按目录时间淘汰最旧的
 * - 快照只覆盖 write_file / edit_file；run_command 的副作用无法预知，不在覆盖范围
 */

const MAX_SNAPSHOTS_PER_SESSION = 100

export interface SnapshotEntry {
  /** 项目内相对路径 */
  path: string
  /** 备份文件名（existedBefore=false 时为空） */
  backupName: string
  /** 修改前文件是否存在（false = 本次是新建，回滚时应删除） */
  existedBefore: boolean
  ts: number
}

export interface RestoreResult {
  /** 恢复内容的文件（相对路径） */
  restored: string[]
  /** 被删除的新建文件（相对路径） */
  deleted: string[]
  /** 回滚前当前状态的快照 id（撤销本次回滚用） */
  undoSnapshotId: string | null
}

export function sessionCheckpointsRoot(projectId: string, sessionId: string): string {
  return join(app.getPath('userData'), 'checkpoints', projectId, sessionId)
}

/** 修改前快照：把即将被覆盖的文件复制进 <toolUseId>/ 并写清单 */
export async function snapshotFilesBeforeChange(
  checkpointsRoot: string,
  toolUseId: string,
  projectPath: string,
  files: string[],
): Promise<void> {
  const dir = join(checkpointsRoot, toolUseId)
  const entries: SnapshotEntry[] = []
  let n = 0
  for (const rel of files) {
    let abs: string
    try {
      abs = safeResolve(projectPath, rel)
    } catch {
      continue // 越界路径不快照（工具本身也会拒绝执行）
    }
    let content: string | null = null
    try {
      content = await readFile(abs, 'utf-8')
    } catch {
      content = null // 文件不存在 → 本次是新建
    }
    const entry: SnapshotEntry = { path: rel, backupName: '', existedBefore: content != null, ts: Date.now() }
    if (content != null) {
      entry.backupName = `backup-${n++}`
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, entry.backupName), content, 'utf-8')
    }
    entries.push(entry)
  }
  if (entries.length > 0) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.json'), JSON.stringify(entries, null, 2), 'utf-8')
  }
  await pruneSnapshots(checkpointsRoot)
}

/** 滚动淘汰：每会话最多保留 MAX_SNAPSHOTS_PER_SESSION 份 */
async function pruneSnapshots(root: string): Promise<void> {
  let dirs
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return
  }
  if (dirs.length <= MAX_SNAPSHOTS_PER_SESSION) return
  const withTime = await Promise.all(
    dirs.map(async (name) => ({
      name,
      mtime: (await stat(join(root, name)).catch(() => null))?.mtimeMs ?? 0,
    })),
  )
  withTime.sort((a, b) => a.mtime - b.mtime)
  for (const d of withTime.slice(0, withTime.length - MAX_SNAPSHOTS_PER_SESSION)) {
    await rm(join(root, d.name), { recursive: true, force: true })
  }
}

/**
 * 回滚：把快照里的文件写回原路径（existedBefore=false 的新建文件删除）。
 * 回滚前先把当前状态拍成 restore-<ts> 快照——撤销本次回滚时用它。
 */
export async function restoreSnapshot(
  checkpointsRoot: string,
  toolUseId: string,
  projectPath: string,
): Promise<RestoreResult> {
  const dir = join(checkpointsRoot, toolUseId)
  const entries = JSON.parse(await readFile(join(dir, 'index.json'), 'utf-8')) as SnapshotEntry[]

  const undoSnapshotId = `restore-${Date.now()}`
  await snapshotFilesBeforeChange(
    checkpointsRoot,
    undoSnapshotId,
    projectPath,
    entries.map((e) => e.path),
  )

  const restored: string[] = []
  const deleted: string[] = []
  for (const e of entries) {
    const abs = safeResolve(projectPath, e.path)
    if (e.existedBefore) {
      const content = await readFile(join(dir, e.backupName), 'utf-8')
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, content, 'utf-8')
      restored.push(e.path)
    } else {
      await rm(abs, { force: true })
      deleted.push(e.path)
    }
  }
  return { restored, deleted, undoSnapshotId }
}

/** 删除会话时连带清理其全部检查点 */
export async function deleteSessionCheckpoints(projectId: string, sessionId: string): Promise<void> {
  await rm(join(app.getPath('userData'), 'checkpoints', projectId, sessionId), {
    recursive: true,
    force: true,
  })
}

/** 删除项目时连带清理其全部检查点 */
export async function deleteProjectCheckpoints(projectId: string): Promise<void> {
  await rm(join(app.getPath('userData'), 'checkpoints', projectId), { recursive: true, force: true })
}

export function registerFileHistoryHandlers(): void {
  const root = (projectId: string, sessionId: string): string =>
    sessionCheckpointsRoot(projectId, sessionId)

  ipcMain.handle(
    'fileHistory:restore',
    async (
      _e,
      projectId: string,
      sessionId: string,
      toolUseId: string,
    ): Promise<RestoreResult | { error: string } | null> => {
      const cfg = await loadConfig()
      const projectPath = cfg.projects.find((p) => p.id === projectId)?.path ?? null
      if (!projectPath) return { error: '项目不存在' }
      try {
        return await restoreSnapshot(root(projectId, sessionId), toolUseId, projectPath)
      } catch (err) {
        // 快照不存在（未快照 / 已清理）等情形
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
