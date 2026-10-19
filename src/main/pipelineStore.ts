import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureVideoWorkspace } from './videoMode'

/**
 * 流水线工程文件：每个视频会话一套（workspace/pipeline/）。
 * versions/v<N>.json 每次保存追加、永不覆盖；current 指向当前版本；
 * runs/<runId>/state.json 记录每次执行的节点状态（支持 resume 跳过已完成节点）。
 */

export const PIPELINE_NODE_TYPES = ['script', 'tts', 'ffmpeg', 'image', 'video', 'asr'] as const
export type PipelineNodeType = (typeof PIPELINE_NODE_TYPES)[number]

export interface PipelineNode {
  id: string
  type: PipelineNodeType
  name: string
  params: Record<string, unknown>
  deps: string[]
  /** 输入槽 → 依赖节点 id（产物传递） */
  inputFrom?: Record<string, string>
  enabled?: boolean
}

export interface PipelineDoc {
  schema: 1
  name: string
  nodes: PipelineNode[]
}

export interface PipelineVersionMeta {
  revision: number
  note: string
  savedAt: number
}

export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'disabled'

export interface PipelineNodeState {
  status: NodeStatus
  error?: string
  /** 工作区相对路径 */
  outputs?: string[]
  startedAt?: number
  finishedAt?: number
}

export interface PipelineRunState {
  runId: string
  revision: number
  startedAt: number
  finishedAt?: number
  nodes: Record<string, PipelineNodeState>
}

export interface PipelineBundle {
  revision: number
  doc: PipelineDoc
  versions: PipelineVersionMeta[]
}

const MAX_NODES = 50
const MAX_NAME = 100

/** 校验流水线文档（纯函数，测试用）：结构、id 唯一、deps 引用存在且无环 */
export function validatePipeline(value: unknown): PipelineDoc {
  if (!value || typeof value !== 'object') throw new Error('流水线必须是对象')
  const raw = value as Record<string, unknown>
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : ''
  if (!name || name.length > MAX_NAME) throw new Error(`name 必须为 1–${MAX_NAME} 字符`)
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) throw new Error('nodes 必须是非空数组')
  if (raw.nodes.length > MAX_NODES) throw new Error(`节点最多 ${MAX_NODES} 个`)

  const nodes: PipelineNode[] = raw.nodes.map((n, i) => {
    if (!n || typeof n !== 'object') throw new Error(`第 ${i + 1} 个节点必须是对象`)
    const node = n as Record<string, unknown>
    const id = typeof node.id === 'string' ? node.id.trim() : ''
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(id)) throw new Error(`节点 id 不合法（${id || '空'}）：字母开头，≤32 位字母数字-_`)
    if (!PIPELINE_NODE_TYPES.includes(node.type as PipelineNodeType)) throw new Error(`节点 ${id} 的 type 不支持（${String(node.type)}）`)
    if (typeof node.name !== 'string' || !node.name.trim()) throw new Error(`节点 ${id} 缺少 name`)
    if (node.params != null && (typeof node.params !== 'object' || Array.isArray(node.params))) throw new Error(`节点 ${id} 的 params 必须是对象`)
    const deps = node.deps ?? []
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) throw new Error(`节点 ${id} 的 deps 必须是字符串数组`)
    if (node.inputFrom != null && (typeof node.inputFrom !== 'object' || Array.isArray(node.inputFrom))) throw new Error(`节点 ${id} 的 inputFrom 必须是对象`)
    return {
      id,
      type: node.type as PipelineNodeType,
      name: node.name.trim().slice(0, MAX_NAME),
      params: (node.params ?? {}) as Record<string, unknown>,
      deps: deps as string[],
      inputFrom: node.inputFrom as Record<string, string> | undefined,
      enabled: node.enabled !== false,
    }
  })

  const ids = new Set(nodes.map((n) => n.id))
  if (ids.size !== nodes.length) throw new Error('节点 id 重复')
  for (const node of nodes) {
    for (const dep of [...node.deps, ...Object.values(node.inputFrom ?? {})]) {
      if (!ids.has(dep)) throw new Error(`节点 ${node.id} 依赖了不存在的节点：${dep}`)
    }
  }
  // Kahn 拓扑排序检测环
  const indegree = new Map(nodes.map((n) => [n.id, new Set([...n.deps, ...Object.values(n.inputFrom ?? {})]).size]))
  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id)
  let visited = 0
  while (queue.length) {
    const id = queue.shift()!
    visited++
    for (const node of nodes) {
      if (new Set([...node.deps, ...Object.values(node.inputFrom ?? {})]).has(id)) {
        const next = (indegree.get(node.id) ?? 0) - 1
        indegree.set(node.id, next)
        if (next === 0) queue.push(node.id)
      }
    }
  }
  if (visited !== nodes.length) throw new Error('流水线存在循环依赖')

  return { schema: 1, name, nodes }
}

/** 拓扑顺序（纯函数，测试用）：deps/inputFrom 都满足的稳定排序 */
export function topoSort(doc: PipelineDoc): PipelineNode[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const visited = new Set<string>()
  const order: PipelineNode[] = []
  const visit = (node: PipelineNode): void => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    for (const depId of new Set([...node.deps, ...Object.values(node.inputFrom ?? {})])) {
      const dep = byId.get(depId)
      if (dep) visit(dep)
    }
    order.push(node)
  }
  for (const node of doc.nodes) visit(node)
  return order
}

function pipelineDir(root: string): string {
  return join(root, 'pipeline')
}
function versionsDir(root: string): string {
  return join(pipelineDir(root), 'versions')
}
function runsDir(root: string): string {
  return join(pipelineDir(root), 'runs')
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** 保存为新版本（追加式），并移动 current 指针；返回版本号 */
export async function savePipeline(sessionId: string, doc: PipelineDoc, note: string): Promise<number> {
  const ws = await ensureVideoWorkspace(sessionId)
  await mkdir(versionsDir(ws.root), { recursive: true })
  const metas = await listVersions(ws.root)
  const revision = (metas[metas.length - 1]?.revision ?? 0) + 1
  await writeFile(join(versionsDir(ws.root), `v${revision}.json`), JSON.stringify({ ...doc, revision, note, savedAt: Date.now() }, null, 2), 'utf8')
  await writeFile(join(pipelineDir(ws.root), 'current.json'), JSON.stringify({ revision }), 'utf8')
  return revision
}

async function listVersions(root: string): Promise<PipelineVersionMeta[]> {
  const files = await readdir(versionsDir(root)).catch(() => [] as string[])
  const metas: PipelineVersionMeta[] = []
  for (const f of files) {
    const m = /^v(\d+)\.json$/.exec(f)
    if (!m) continue
    const data = await readJson<PipelineVersionMeta>(join(versionsDir(root), f))
    if (data) metas.push({ revision: Number(m[1]), note: data.note ?? '', savedAt: data.savedAt ?? 0 })
  }
  return metas.sort((a, b) => a.revision - b.revision)
}

/** 当前流水线 + 版本列表；从未保存过返回 null */
export async function loadPipeline(sessionId: string): Promise<PipelineBundle | null> {
  const ws = await ensureVideoWorkspace(sessionId)
  const pointer = await readJson<{ revision: number }>(join(pipelineDir(ws.root), 'current.json'))
  if (!pointer) return null
  const doc = await readJson<PipelineDoc & PipelineVersionMeta>(join(versionsDir(ws.root), `v${pointer.revision}.json`))
  if (!doc) return null
  const { revision: _r, note: _n, savedAt: _s, ...bare } = doc
  return { revision: pointer.revision, doc: bare, versions: await listVersions(ws.root) }
}

/** 指定版本回退：把该版本内容另存为新版本（保留完整历史），并指向它 */
export async function restorePipelineRevision(sessionId: string, revision: number, note: string): Promise<number> {
  const ws = await ensureVideoWorkspace(sessionId)
  const doc = await readJson<PipelineDoc>(join(versionsDir(ws.root), `v${revision}.json`))
  if (!doc) throw new Error(`版本 v${revision} 不存在`)
  const { schema, name, nodes } = doc
  return savePipeline(sessionId, { schema, name, nodes }, note || `回退到 v${revision}`)
}

/** 新建一次运行记录 */
export async function startRun(sessionId: string, revision: number): Promise<{ runId: string; dir: string }> {
  const ws = await ensureVideoWorkspace(sessionId)
  const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const dir = join(runsDir(ws.root), runId)
  await mkdir(dir, { recursive: true })
  const state: PipelineRunState = { runId, revision, startedAt: Date.now(), nodes: {} }
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
  return { runId, dir }
}

/** 增量写回运行状态（每个节点结束后调用，崩溃可恢复） */
export async function saveRunState(runDir: string, state: PipelineRunState): Promise<void> {
  await writeFile(join(runDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
}

export async function readRunState(runDir: string): Promise<PipelineRunState | null> {
  return readJson<PipelineRunState>(join(runDir, 'state.json'))
}

/** 最近一次运行（resume 用） */
export async function latestRunDir(sessionId: string): Promise<string | null> {
  const ws = await ensureVideoWorkspace(sessionId)
  const ids = (await readdir(runsDir(ws.root)).catch(() => [] as string[])).sort()
  return ids.length ? join(runsDir(ws.root), ids[ids.length - 1]) : null
}

/** 节点产物目录：outputs/.pipeline/<nodeId>/ */
export async function nodeOutputDir(sessionId: string, nodeId: string): Promise<string> {
  const ws = await ensureVideoWorkspace(sessionId)
  const dir = join(ws.outputs, '.pipeline', nodeId)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function deleteRunDirs(sessionId: string, keep: number): Promise<void> {
  const ws = await ensureVideoWorkspace(sessionId)
  const ids = (await readdir(runsDir(ws.root)).catch(() => [] as string[])).sort()
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) {
    await rm(join(runsDir(ws.root), id), { recursive: true, force: true })
  }
}
