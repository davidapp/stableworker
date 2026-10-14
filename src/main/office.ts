import { app, dialog, ipcMain, shell } from 'electron'
import { copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConfigView, OfficeFile, OfficeFormat, OfficePreviewResult } from '../shared/types'
import { extractOfficeDocument } from './officeDocuments'
import { loadConfig, saveConfig } from './config'

export const MAX_OFFICE_FILE_BYTES = 25 * 1024 * 1024
const formats = new Set<OfficeFormat>(['docx', 'xlsx', 'pptx', 'pdf', 'txt', 'md', 'csv'])

export function officeFormat(path: string): OfficeFormat {
  const format = extname(path).slice(1).toLowerCase() as OfficeFormat
  if (!formats.has(format)) throw new Error('支持 DOCX、XLSX、PPTX、PDF、TXT、Markdown 和 CSV 文件')
  return format
}

export function officeWorkspaceRoot(): string {
  return join(app.getPath('userData'), 'office')
}

export async function ensureOfficeWorkspace(sessionId: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('办公任务 ID 无效')
  const root = join(officeWorkspaceRoot(), 'sessions', sessionId)
  // Managed directories must not redirect file access outside the task.
  for (const dir of [officeWorkspaceRoot(), join(officeWorkspaceRoot(), 'sessions'), root, join(root, 'inputs'), join(root, 'outputs')]) {
    try { await mkdir(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const info = await lstat(dir)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('办公目录不允许符号链接')
  }
  return root
}

/** Only immediate files in inputs/outputs are exposed to Office IPC and document tools. */
export async function resolveOfficeFile(root: string, path: string, allowMissing = false): Promise<string> {
  if (!/^(inputs|outputs)\/[^/\\]+$/.test(path) || /[\x00-\x1f]/.test(path)) throw new Error('办公文件路径无效')
  const abs = resolve(root, path)
  if (!abs.startsWith(resolve(root) + sep)) throw new Error('办公文件路径越界')
  for (const dir of [root, join(root, path.split('/')[0])]) {
    const info = await lstat(dir)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('办公目录不允许符号链接')
  }
  try {
    const info = await lstat(abs)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('只能操作普通办公文件')
    if (info.size > MAX_OFFICE_FILE_BYTES) throw new Error('办公文件超过 25 MB 上限')
  } catch (error) {
    if (!(allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error
  }
  officeFormat(path)
  return abs
}

export async function listOfficeFiles(root: string): Promise<OfficeFile[]> {
  const files: OfficeFile[] = []
  for (const dir of ['inputs', 'outputs']) {
    for (const name of await readdir(join(root, dir))) {
      const path = `${dir}/${name}`
      try {
        const abs = await resolveOfficeFile(root, path)
        const info = await lstat(abs)
        files.push({ path, name, size: info.size, format: officeFormat(name), role: dir === 'inputs' ? 'input' : 'output', modifiedAt: info.mtimeMs })
      } catch { /* Unsupported files, temporary files and links are not exposed. */ }
    }
  }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export async function extractOfficeFile(root: string, path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const abs = await resolveOfficeFile(root, path)
  const content = await extractOfficeDocument(await readFile(abs), officeFormat(path), signal)
  signal?.throwIfAborted()
  return content
}

/** Called only after the user selected these paths in the native file picker. */
export async function copyOfficeAttachments(root: string, selectedPaths: string[]): Promise<OfficeFile[]> {
  const paths: string[] = []
  for (const source of selectedPaths) {
    officeFormat(source)
    const info = await lstat(source)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('只能导入普通文件')
    if (info.size > MAX_OFFICE_FILE_BYTES) throw new Error(`${basename(source)} 超过 25 MB 上限`)
    const name = basename(source).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    const path = `inputs/${randomUUID().slice(0, 8)}-${name}`
    const target = await resolveOfficeFile(root, path, true)
    await copyFile(source, target, constants.COPYFILE_EXCL)
    paths.push(path)
  }
  return (await listOfficeFiles(root)).filter((file) => paths.includes(file.path))
}

export function registerOfficeHandlers(): void {
  ipcMain.handle('office:workspace', async (): Promise<ConfigView> => {
    const cfg = await loadConfig()
    const project = cfg.projects.find((item) => item.id === 'office-workspace')
    if (project) {
      project.path = officeWorkspaceRoot()
      project.name = '办公任务'
    } else cfg.projects.push({ id: 'office-workspace', name: '办公任务', path: officeWorkspaceRoot(), createdAt: Date.now() })
    await mkdir(officeWorkspaceRoot(), { recursive: true })
    return saveConfig(cfg)
  })
  ipcMain.handle('office:import', async (_e, sessionId: string): Promise<OfficeFile[]> => {
    const root = await ensureOfficeWorkspace(sessionId)
    const selected = await dialog.showOpenDialog({ title: '导入办公资料', properties: ['openFile', 'multiSelections'], filters: [{ name: '办公资料', extensions: [...formats] }] })
    return selected.canceled ? [] : copyOfficeAttachments(root, selected.filePaths)
  })
  ipcMain.handle('office:list', async (_e, sessionId: string): Promise<OfficeFile[]> => listOfficeFiles(await ensureOfficeWorkspace(sessionId)))
  ipcMain.handle('office:open', async (_e, sessionId: string, path: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const abs = await resolveOfficeFile(await ensureOfficeWorkspace(sessionId), path)
      const error = await shell.openPath(abs)
      return error ? { ok: false, error } : { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('office:preview', async (_e, sessionId: string, path: string): Promise<OfficePreviewResult> => {
    try {
      const root = await ensureOfficeWorkspace(sessionId)
      const content = await extractOfficeFile(root, path)
      return { ok: true, kind: officeFormat(path) === 'pdf' ? 'pdf' : 'text', content: content.slice(0, 60_000) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
}
