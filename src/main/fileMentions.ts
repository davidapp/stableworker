import { ipcMain, shell } from 'electron'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { loadConfig } from './config'
import { safeResolve } from './tools/paths'

/**
 * @文件引用（对齐 Claude Code 的 @path 提及）：
 * - files:complete —— 补全列表：递归收集项目内文本文件（忽略 node_modules/.git/二进制/大文件），
 *   按输入片段不区分大小写过滤（路径或文件名命中都算），每次补全结果 ≤30 条；同一项目 5s 缓存。
 * - files:readMentions —— 发送时读取 @路径 的文件内容（单文件 20k 字符截断，总预算 60k）。
 * 渲染端把内容以 [引用文件：路径] 分节拼进消息文本后再发送/持久化（历史即所见）。
 */

const MAX_COMPLETE = 30
const MAX_MENTION_CHARS = 20_000
const MAX_TOTAL_CHARS = 60_000
const MAX_WALK_FILES = 5000
const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'out', 'build', 'coverage', '.next', '.nuxt', '__pycache__', 'venv', '.venv'])
const BINARY_EXT =
  /\.(png|jpe?g|gif|bmp|webp|ico|icns|woff2?|ttf|otf|eot|exe|dll|so|dylib|zip|gz|tar|7z|rar|pdf|mp[34]|avi|mov|mkv|sqlite3?|db|class|jar|wasm|node)$/i

async function walkRel(dir: string, root: string, out: string[]): Promise<void> {
  if (out.length >= MAX_WALK_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= MAX_WALK_FILES) return
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue
      await walkRel(full, root, out)
    } else if (e.isFile() && !BINARY_EXT.test(e.name)) {
      out.push(relative(root, full).replaceAll('\\', '/'))
    }
  }
}

/** 按片段过滤相对路径（路径或文件名不区分大小写包含命中），返回前 limit 条 */
export function filterPaths(relPaths: string[], query: string, limit = MAX_COMPLETE): string[] {
  const q = query.toLowerCase()
  const scored: { path: string; score: number }[] = []
  for (const p of relPaths) {
    const lower = p.toLowerCase()
    const base = lower.lastIndexOf('/')
    const name = lower.slice(base + 1)
    let score = -1
    if (name === q) score = 0
    else if (name.startsWith(q)) score = 1
    else if (name.includes(q)) score = 2
    else if (lower.includes(q)) score = 3
    if (score >= 0) scored.push({ path: p, score })
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map((s) => s.path)
}

export interface MentionResult {
  path: string
  content: string | null
  /** 未找到 / 越界 / 是目录 */
  missing: boolean
  truncated: boolean
}

/** 读取一批 @路径（安全解析在项目内；单文件与总预算截断） */
export async function resolveMentions(projectPath: string, paths: string[]): Promise<MentionResult[]> {
  const out: MentionResult[] = []
  let budget = MAX_TOTAL_CHARS
  for (const raw of paths.slice(0, 10)) {
    const rel = String(raw ?? '').trim().replace(/^\/+/, '')
    if (!rel) continue
    let target: string
    try {
      target = safeResolve(projectPath, rel)
    } catch {
      out.push({ path: rel, content: null, missing: true, truncated: false })
      continue
    }
    const st = await stat(target).catch(() => null)
    if (!st || !st.isFile()) {
      out.push({ path: rel, content: null, missing: true, truncated: false })
      continue
    }
    if (budget <= 0) {
      out.push({ path: rel, content: null, missing: false, truncated: true })
      continue
    }
    const text = await readFile(target, 'utf-8').catch(() => null)
    if (text == null) {
      out.push({ path: rel, content: null, missing: true, truncated: false })
      continue
    }
    const clipped = text.slice(0, Math.min(MAX_MENTION_CHARS, budget))
    const truncated = clipped.length < text.length
    budget -= clipped.length
    out.push({ path: rel, content: clipped, missing: false, truncated })
  }
  return out
}

const completeCache = new Map<string, { at: number; paths: string[] }>()

export function registerFileMentionHandlers(): void {
  ipcMain.handle('files:complete', async (_e, projectId: string, query: string): Promise<string[]> => {
    const cfg = await loadConfig()
    const projectPath = cfg.projects.find((p) => p.id === projectId)?.path
    if (!projectPath) return []
    const cached = completeCache.get(projectPath)
    let relPaths: string[]
    if (cached && Date.now() - cached.at < 5_000) {
      relPaths = cached.paths
    } else {
      const abs: string[] = []
      await walkRel(projectPath, projectPath, abs)
      relPaths = abs
      completeCache.set(projectPath, { at: Date.now(), paths: relPaths })
    }
    return filterPaths(relPaths, String(query ?? ''))
  })

  // 工作目录文件树（扁平相对路径列表，客户端组树；忽略规则与 @补全一致）
  ipcMain.handle('files:tree', async (_e, projectId: string): Promise<string[]> => {
    const cfg = await loadConfig()
    const projectPath = cfg.projects.find((p) => p.id === projectId)?.path
    if (!projectPath) return []
    const cached = completeCache.get(projectPath)
    if (cached && Date.now() - cached.at < 5_000) return cached.paths
    const abs: string[] = []
    await walkRel(projectPath, projectPath, abs)
    completeCache.set(projectPath, { at: Date.now(), paths: abs })
    return abs
  })

  // 在系统资源管理器中打开（rel 省略 = 打开工作目录本身）
  ipcMain.handle('files:openPath', async (_e, projectId: string, rel?: string): Promise<{ ok: boolean; error?: string }> => {
    const cfg = await loadConfig()
    const projectPath = cfg.projects.find((p) => p.id === projectId)?.path
    if (!projectPath) return { ok: false, error: '项目不存在' }
    if (!rel) {
      await shell.openPath(projectPath)
      return { ok: true }
    }
    let target: string
    try {
      target = safeResolve(projectPath, String(rel).trim())
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    const err = await shell.openPath(target)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle('files:readMentions', async (_e, projectId: string, paths: string[]): Promise<MentionResult[]> => {
    const cfg = await loadConfig()
    const projectPath = cfg.projects.find((p) => p.id === projectId)?.path
    if (!projectPath) return (Array.isArray(paths) ? paths : []).map((p) => ({ path: p, content: null, missing: true, truncated: false }))
    return resolveMentions(projectPath, Array.isArray(paths) ? paths : [])
  })
}
