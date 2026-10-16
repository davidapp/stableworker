import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { app, ipcMain } from 'electron'
import { loadConfig } from './config'

/**
 * 分层记忆（对齐 Claude Code 的 CLAUDE.md 层级模型，近处覆盖注意力更高）：
 *   全局 userData/AGENTS.md → 项目父目录逐级向上 → 项目 AGENTS.md → 项目 AGENTS.local.md
 * 所有层支持 @路径 引用（整行形如 "@notes/tech.md"，相对所在文件目录，可嵌套，
 * 深度 ≤3、环引用安全、总量受限）。拼接顺序远→近，注入系统提示词。
 * 另有按项目隔离的记忆目录（memory 工具读写），见 memoryDir.ts。
 */

const MAX_FILE_CHARS = 20_000
const MAX_TOTAL_CHARS = 48_000
const MAX_INCLUDE_DEPTH = 3
const MAX_INCLUDE_CHARS = 20_000

export interface MemoryLayer {
  label: string
  path: string
  /** 文件原文（未展开 @引用）；不存在为 null */
  raw: string | null
}

/** 全局层路径（userData/AGENTS.md） */
export function globalAgentsMdPath(): string {
  return join(app.getPath('userData'), 'AGENTS.md')
}

/** 逐级向上的父目录候选（不含项目目录本身），从最远到最近 */
function ancestorDirs(projectPath: string): string[] {
  const out: string[] = []
  let dir = dirname(resolve(projectPath))
  const stop = resolve(projectPath)
  while (true) {
    if (resolve(dir) !== stop) out.push(resolve(dir))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out.reverse() // 远 → 近
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    const text = raw.trim()
    return text || null
  } catch {
    return null
  }
}

/** 收集所有记忆层（远 → 近；raw 为文件原文，不存在则 null） */
export async function loadMemoryLayers(
  projectPath: string | null,
  globalDir?: string,
): Promise<MemoryLayer[]> {
  const layers: MemoryLayer[] = []
  const globalPath = globalDir ? join(globalDir, 'AGENTS.md') : globalAgentsMdPath()
  layers.push({ label: '全局', path: globalPath, raw: await readOrNull(globalPath) })
  if (projectPath) {
    for (const dir of ancestorDirs(projectPath)) {
      const p = join(dir, 'AGENTS.md')
      layers.push({ label: `父目录 ${dir}`, path: p, raw: await readOrNull(p) })
    }
    const projectPath2 = join(projectPath, 'AGENTS.md')
    layers.push({ label: '项目', path: projectPath2, raw: await readOrNull(projectPath2) })
    const localPath = join(projectPath, 'AGENTS.local.md')
    layers.push({ label: '项目本地', path: localPath, raw: await readOrNull(localPath) })
  }
  // 同一路径只保留最后一次出现（近处优先）
  const byPath = new Map<string, MemoryLayer>()
  for (const l of layers) byPath.set(resolve(l.path), l)
  return [...byPath.values()]
}

/** 展开 @路径 引用（整行 @xxx，相对 baseDir；深度/环/预算受限） */
async function expandIncludes(
  content: string,
  baseDir: string,
  depth: number,
  budget: { left: number },
  visited: Set<string>,
): Promise<string> {
  const lines = content.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const m = /^\s*@(\S+)\s*$/.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    const ref = m[1]
    const display = `@${ref}`
    if (depth >= MAX_INCLUDE_DEPTH) {
      out.push(`> （引用过深，已跳过：${display}）`)
      continue
    }
    const target = isAbsolute(ref) ? ref : resolve(baseDir, ref)
    const key = resolve(target)
    if (visited.has(key)) {
      out.push(`> （循环引用，已跳过：${display}）`)
      continue
    }
    if (budget.left <= 0) {
      out.push(`> （引用预算已用尽，已跳过：${display}）`)
      continue
    }
    const raw = await readOrNull(target)
    if (raw == null) {
      out.push(`> （引用缺失：${display}）`)
      continue
    }
    visited.add(key)
    const body = raw.length > budget.left ? raw.slice(0, budget.left) + '\n…（引用过长，已截断）' : raw
    budget.left -= body.length
    const expanded = await expandIncludes(body, dirname(target), depth + 1, budget, visited)
    out.push(`<!-- 引用自 ${display} -->\n${expanded}`)
  }
  return out.join('\n')
}

/** 组装注入系统提示词的记忆文本（无任何层时返回空串） */
export async function loadAgentsMd(projectPath: string | null, globalDir?: string): Promise<string> {
  const layers = await loadMemoryLayers(projectPath, globalDir)
  const parts: string[] = []
  let total = 0
  for (const layer of layers) {
    if (layer.raw == null) continue
    const expanded = await expandIncludes(layer.raw, dirname(layer.path), 0, { left: MAX_INCLUDE_CHARS }, new Set([resolve(layer.path)]))
    const label = layer.label.startsWith('父目录') ? '项目（父目录约定）' : layer.label
    let body = expanded.length > MAX_FILE_CHARS ? expanded.slice(0, MAX_FILE_CHARS) + '\n…（内容过长，已截断）' : expanded
    if (total + body.length > MAX_TOTAL_CHARS) {
      body = body.slice(0, Math.max(0, MAX_TOTAL_CHARS - total)) + '\n…（记忆总量已达上限，本层截断）'
    }
    parts.push(`【记忆层：${label} · ${layer.path}】\n${body}`)
    total += body.length
    if (total >= MAX_TOTAL_CHARS) break
  }
  return parts.join('\n\n')
}

// ---------- 设置页 IPC：分层查看 / 编辑 ----------

export function registerMemoryHandlers(): void {
  ipcMain.handle('memory:getLayers', async (_e, projectId: string) => {
    const cfg = await loadConfig()
    const projectPath = cfg.projects.find((p) => p.id === projectId)?.path ?? null
    return { layers: await loadMemoryLayers(projectPath) }
  })

  ipcMain.handle(
    'memory:saveLayer',
    async (_e, projectId: string, kind: 'global' | 'project' | 'local', content: string) => {
      const cfg = await loadConfig()
      let path: string
      if (kind === 'global') {
        path = globalAgentsMdPath()
        await mkdir(dirname(path), { recursive: true })
      } else {
        const projectPath = cfg.projects.find((p) => p.id === projectId)?.path
        if (!projectPath) return { ok: false, error: '没有激活项目' }
        path = join(projectPath, kind === 'local' ? 'AGENTS.local.md' : 'AGENTS.md')
      }
      try {
        await writeFile(path, content, 'utf-8')
        return { ok: true, path }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )
}
