import { app, dialog, ipcMain, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants, lstat, mkdir, readdir, stat, copyFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { loadConfig, saveConfig } from './config'
import type { ConfigView } from '../shared/types'
import { videoSystemPrompt } from './officeMode'

/**
 * 视频模式（taskMode 'video'）的工作区：userData/video/sessions/<id>/ 下
 * inputs/（导入的图片/音频素材）与 outputs/（配音、分镜、成品 MP4）。
 * 与办公任务同构：虚拟项目 'video-workspace'，附件经原生对话框导入，删除会话连带清理文件。
 */

export interface VideoFile {
  path: string
  bytes: number
}

export const VIDEO_IMPORT_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']
const MAX_VIDEO_FILE_BYTES = 100 * 1024 * 1024

export function videoWorkspaceRoot(): string {
  return join(app.getPath('userData'), 'video')
}

export function videoWorkspace(sessionId: string): { root: string; inputs: string; outputs: string } {
  const root = join(videoWorkspaceRoot(), 'sessions', sessionId)
  return { root, inputs: join(root, 'inputs'), outputs: join(root, 'outputs') }
}

export async function ensureVideoWorkspace(sessionId: string): Promise<{ root: string; inputs: string; outputs: string }> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('视频任务 ID 无效')
  const ws = videoWorkspace(sessionId)
  // 与办公工作区一致：受管目录不允许符号链接重定向
  for (const dir of [videoWorkspaceRoot(), join(videoWorkspaceRoot(), 'sessions'), ws.root, ws.inputs, ws.outputs]) {
    try { await mkdir(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const info = await lstat(dir)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('视频目录不允许符号链接')
  }
  return ws
}

/** 视频模式的系统提示词：指导模型产出分镜脚本（video_compose 的输入） */
export function videoSystemPromptFor(sessionId: string): string {
  const ws = videoWorkspace(sessionId)
  return videoSystemPrompt(ws.root)
}

/** 工作区内相对路径 → 绝对路径，拒绝越界；ensure=true 时要求父目录存在 */
export async function resolveVideoFile(ws: { root: string }, rel: string): Promise<string> {
  if (!rel || rel.includes('\0')) throw new Error(`路径无效：${rel}`)
  const abs = resolve(ws.root, rel)
  if (abs !== ws.root && !abs.startsWith(ws.root + sep)) throw new Error(`路径必须位于任务目录内：${rel}`)
  return abs
}

/** 导入素材到 inputs/：文件名加短随机前缀防碰撞，校验扩展名、大小与符号链接 */
export async function copyVideoAttachments(ws: { root: string; inputs: string }, selectedPaths: string[]): Promise<VideoFile[]> {
  const imported: string[] = []
  for (const source of selectedPaths) {
    const ext = source.slice(source.lastIndexOf('.') + 1).toLowerCase()
    if (!VIDEO_IMPORT_EXTS.includes(ext)) throw new Error(`${basename(source)}：仅支持 ${VIDEO_IMPORT_EXTS.join('、')} 素材`)
    const info = await lstat(source)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('只能导入普通文件')
    if (info.size > MAX_VIDEO_FILE_BYTES) throw new Error(`${basename(source)} 超过 100 MB 上限`)
    const name = basename(source).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    const rel = `inputs/${randomUUID().slice(0, 8)}-${name}`
    const target = await resolveVideoFile(ws, rel)
    await copyFile(source, target, constants.COPYFILE_EXCL)
    imported.push(rel)
  }
  return listVideoFiles(ws).then((all) => all.filter((f) => imported.includes(f.path)))
}

/** 列出 inputs/ 与 outputs/ 下的普通文件（跳过 .work 等以点开头的中间目录） */
export async function listVideoFiles(ws: { root: string }): Promise<VideoFile[]> {
  const rows: VideoFile[] = []
  for (const dirName of ['inputs', 'outputs'] as const) {
    const dir = resolve(ws.root, dirName)
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names.filter((n) => !n.startsWith('.')).sort()) {
      const info = await stat(resolve(dir, name)).catch(() => null)
      if (info?.isFile()) rows.push({ path: `${dirName}/${name}`, bytes: info.size })
    }
  }
  return rows
}

/** 工作区内媒体文件的 MIME（audio 元素播放与图片预览用） */
const MEDIA_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}

/** 注册 video-media:// 协议：只服务视频任务工作区内的文件（<audio> 播放用），支持 Range 拖动进度 */
export function registerVideoMediaProtocol(): void {
  protocol.handle('video-media', async (request) => {
    try {
      const url = new URL(request.url)
      const ws = await ensureVideoWorkspace(url.hostname)
      const rel = decodeURIComponent(url.pathname).replace(/^\//, '')
      const abs = await resolveVideoFile(ws, rel)
      const info = await stat(abs)
      if (!info.isFile()) return new Response('not found', { status: 404 })
      const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase()
      const type = MEDIA_MIME[ext] ?? 'application/octet-stream'
      const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '')
      let start = range?.[1] ? Number.parseInt(range[1], 10) : 0
      let end = range?.[2] ? Number.parseInt(range[2], 10) : info.size - 1
      start = Math.max(0, Math.min(start, info.size - 1))
      end = Math.max(start, Math.min(end, info.size - 1))
      const stream = Readable.toWeb(createReadStream(abs, { start, end })) as unknown as ReadableStream
      if (range) {
        return new Response(stream, { status: 206, headers: {
          'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${info.size}`, 'accept-ranges': 'bytes',
        } })
      }
      return new Response(stream, { headers: { 'content-type': type, 'content-length': String(info.size), 'accept-ranges': 'bytes' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

/** 注册视频模式 IPC：虚拟项目引导、素材导入、文件列表、打开文件 */
export function registerVideoModeHandlers(): void {
  ipcMain.handle('video:workspace', async (): Promise<ConfigView> => {
    const cfg = await loadConfig()
    const project = cfg.projects.find((item) => item.id === 'video-workspace')
    if (project) {
      project.path = videoWorkspaceRoot()
      project.name = '视频任务'
    } else cfg.projects.push({ id: 'video-workspace', name: '视频任务', path: videoWorkspaceRoot(), createdAt: Date.now() })
    await mkdir(videoWorkspaceRoot(), { recursive: true })
    return saveConfig(cfg)
  })

  ipcMain.handle('video:import', async (_e, sessionId: string): Promise<VideoFile[]> => {
    const ws = await ensureVideoWorkspace(sessionId)
    const selected = await dialog.showOpenDialog({
      title: '导入视频素材',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频素材（图片/音频）', extensions: VIDEO_IMPORT_EXTS }],
    })
    return selected.canceled ? [] : copyVideoAttachments(ws, selected.filePaths)
  })

  ipcMain.handle('video:files', async (_e, sessionId: string): Promise<VideoFile[]> => {
    const ws = await ensureVideoWorkspace(sessionId)
    return listVideoFiles(ws)
  })

  ipcMain.handle('video:open', async (_e, sessionId: string, path: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const ws = await ensureVideoWorkspace(sessionId)
      const abs = await resolveVideoFile(ws, path)
      const error = await shell.openPath(abs)
      return error ? { ok: false, error } : { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
}
