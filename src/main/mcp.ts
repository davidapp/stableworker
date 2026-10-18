import { spawn, type ChildProcess } from 'node:child_process'
import { ipcMain } from 'electron'
import { fetch as undiciFetch } from 'undici'
import { loadConfig, saveConfig } from './config'
import { killTree } from './tools/shellTasks'
import type { ToolDefinition } from './tools/index'
import type { MCPServerConfig, McpResourceContent, McpResourceMeta, McpServerStatus } from '../shared/types'

/**
 * 最小 MCP（Model Context Protocol）客户端，手写实现（不依赖 @modelcontextprotocol/sdk，规避 ESM 打包问题）：
 *   initialize 握手 → notifications/initialized → tools/list → tools/call（+ resources/list / read）。
 * 两种传输：
 *   - stdio：每台服务器一个子进程，换行分隔 JSON-RPC 2.0；进程意外退出时自动退避重连
 *   - http：Streamable HTTP（POST JSON-RPC，响应为 JSON 或 SSE 流），无会话时自动重新握手
 */

export interface McpTool {
  name: string
  description?: string
  inputSchema: unknown
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
}

interface StdioConn {
  kind: 'stdio'
  name: string
  child: ChildProcess
  buffer: string
  nextId: number
  pending: Map<number, Pending>
  tools: McpTool[]
  status: 'connected' | 'error'
  error?: string
}

interface HttpConn {
  kind: 'http'
  name: string
  url: string
  headers: Record<string, string>
  sessionId?: string
  nextId: number
  tools: McpTool[]
  status: 'connected' | 'error'
  error?: string
  controller: AbortController
}

type Conn = StdioConn | HttpConn

/** 命令行分词：支持双引号包裹含空格的参数；引号内 \" 转义为字面双引号 */
export function tokenize(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '\\' && inQuote && command[i + 1] === '"') {
      cur += '"'
      i++
      continue
    }
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (ch === ' ' && !inQuote) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

const connections = new Map<string, Conn>()
const fingerprints = new Map<string, string>()
const generations = new Map<string, number>()
const generation = (name: string): number => generations.get(name) ?? 0
function invalidate(name: string): void { generations.set(name, generation(name) + 1) }
let lifecycleQueue: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = lifecycleQueue.then(fn, fn)
  lifecycleQueue = result.catch(() => {})
  return result
}
function fingerprint(cfg: Pick<MCPServerConfig, 'command' | 'url' | 'headers' | 'env'>): string {
  const sorted = (kv?: Record<string, string>): [string, string][] => Object.entries(kv ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([cfg.command ?? '', cfg.url ?? '', sorted(cfg.headers), sorted(cfg.env)])
}

// ---------- 断线自动重连（stdio）：退避 5s/15s/30s，之后每 60s 一次 ----------

const RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000]
let currentConfigs: MCPServerConfig[] = []
let shuttingDown = false
const failCounts = new Map<string, number>()
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearReconnect(name: string): void {
  const t = reconnectTimers.get(name)
  if (t) clearTimeout(t)
  reconnectTimers.delete(name)
}

function scheduleReconnect(name: string): void {
  if (shuttingDown || reconnectTimers.has(name)) return
  const cfg = currentConfigs.find((c) => c.name === name)
  if (!cfg || cfg.disabled) return
  const delay = RECONNECT_DELAYS_MS[Math.min(failCounts.get(name) ?? 0, RECONNECT_DELAYS_MS.length - 1)]
  const t = setTimeout(() => {
    reconnectTimers.delete(name)
    const c = currentConfigs.find((x) => x.name === name)
    if (!c || c.disabled) return
    // 已有健康连接则跳过；死连接/握手失败的残留连接先清理再重连
    const existing = connections.get(name)
    if (existing?.status === 'connected') return
    connectServer(name, c)
      .then(() => failCounts.delete(name))
      .catch(() => {
        failCounts.set(name, (failCounts.get(name) ?? 0) + 1)
        scheduleReconnect(name)
      })
  }, delay)
  t.unref?.()
  reconnectTimers.set(name, t)
}

// ---------- stdio 传输 ----------

function send(conn: StdioConn, msg: Record<string, unknown>): void {
  if (!conn.child.stdin || conn.child.stdin.destroyed || conn.child.killed) throw new Error('MCP 输入流已关闭')
  conn.child.stdin.write(JSON.stringify(msg) + '\n')
}

function stdioRequest<T = Record<string, unknown>>(
  conn: StdioConn,
  method: string,
  params: unknown,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error('MCP 请求已取消'))
  if (conn.child.killed || connections.get(conn.name) !== conn) return Promise.reject(new Error('MCP 服务器已断开'))
  const id = ++conn.nextId
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const cancel = (reason: string): void => {
      if (!conn.pending.delete(id)) return
      cleanup()
      if (method !== 'initialize' && !conn.child.killed) {
        try { send(conn, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } }) } catch { /* Closing transport already prevents new requests. */ }
      }
      reject(new Error(reason))
    }
    const onAbort = (): void => cancel('MCP 请求已取消')
    conn.pending.set(id, {
      resolve: (value) => { cleanup(); resolve(value as T) },
      reject: (error) => { cleanup(); reject(error) },
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => cancel(`MCP 请求超时：${method}`), timeoutMs)
    timer.unref?.()
    try { send(conn, { jsonrpc: '2.0', id, method, params }) }
    catch (error) { conn.pending.delete(id); cleanup(); reject(error); return }
    if (signal?.aborted) onAbort()
  })
}

function handleLine(conn: StdioConn, line: string): void {
  const s = line.trim()
  if (!s) return
  let msg: {
    id?: number
    error?: { message?: string }
    result?: Record<string, unknown>
  }
  try {
    msg = JSON.parse(s)
  } catch {
    return // 服务器不规范输出（日志等）忽略
  }
  if (msg.id != null) {
    const p = conn.pending.get(msg.id)
    if (!p) return
    conn.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
    else p.resolve(msg.result ?? {})
  }
  // 通知（无 id）v1 忽略
}

function wireOutput(conn: StdioConn): void {
  conn.buffer = ''
  conn.child.stdout?.on('data', (data: Buffer) => {
    conn.buffer += data.toString('utf8')
    let idx: number
    while ((idx = conn.buffer.indexOf('\n')) >= 0) {
      const line = conn.buffer.slice(0, idx)
      conn.buffer = conn.buffer.slice(idx + 1)
      handleLine(conn, line)
    }
  })
  conn.child.stderr?.on('data', () => {
    // 服务器 stderr 是它的日志，v1 忽略
  })
}

async function connectStdio(
  name: string,
  cfg: Pick<MCPServerConfig, 'command' | 'env'>,
): Promise<void> {
  const parts = tokenize(cfg.command ?? '')
  if (parts.length === 0) throw new Error('启动命令为空')
  const child = spawn(parts[0], parts.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: cfg.env ? { ...process.env, ...cfg.env } : undefined,
  })
  const conn: StdioConn = {
    kind: 'stdio',
    name,
    child,
    buffer: '',
    nextId: 0,
    pending: new Map(),
    tools: [],
    status: 'error',
  }
  connections.set(name, conn)
  wireOutput(conn)

  // A closed stdin raises EPIPE on Writable, not on ChildProcess.
  const failConnection = (err: Error): void => {
    if (connections.get(name) !== conn) return
    conn.status = 'error'
    conn.error = err.message
    conn.tools = []
    for (const p of conn.pending.values()) p.reject(new Error('MCP 服务器连接失败：' + err.message))
    conn.pending.clear()
    killTree(child)
    scheduleReconnect(name)
  }
  conn.child.on('error', failConnection)
  conn.child.stdin?.on('error', failConnection)
  child.on('exit', () => {
    if (connections.get(name) !== conn) return // 已被 disconnectServer 主动移除
    conn.status = 'error'
    conn.error = '进程已退出'
    conn.tools = []
    for (const p of conn.pending.values()) p.reject(new Error('MCP 服务器进程已退出'))
    conn.pending.clear()
    scheduleReconnect(name)
  })

  try {
    await stdioRequest(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'StableWorker', version: '0.9.5' },
    })
    send(conn, { jsonrpc: '2.0', method: 'notifications/initialized' })
    const tl = await stdioRequest<{ tools?: McpTool[] }>(conn, 'tools/list', undefined)
    conn.tools = tl.tools ?? []
    conn.status = 'connected'
    conn.error = undefined
  } catch (e) {
    conn.status = 'error'
    conn.error = (e as Error).message
    throw e
  }
}

// ---------- Streamable HTTP 传输 ----------

async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const separator = buf.slice(idx).match(/^\r?\n\r?\n/)![0]
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + separator.length)
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (data) yield data
    }
  }
}

interface RpcResult {
  id?: number
  error?: { message?: string }
  result?: Record<string, unknown>
}

/** POST 一条 JSON-RPC 消息：响应可能是纯 JSON，也可能是 SSE 流（逐事件找匹配 id 的响应） */
async function httpExchange(
  conn: HttpConn,
  msg: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  signal?.throwIfAborted()
  conn.controller.signal.throwIfAborted()
  const ac = new AbortController()
  let sent = false
  const cancel = (reason: string): void => {
    if (!ac.signal.aborted && sent && msg.id != null && msg.method !== 'initialize') {
      void httpExchange(conn, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: msg.id, reason } }, 2_000).catch(() => {})
    }
    ac.abort(new Error(reason))
  }
  const onAbort = (): void => cancel('MCP 请求已取消')
  const onDisconnect = (): void => ac.abort(new Error('MCP 服务器已断开'))
  signal?.addEventListener('abort', onAbort, { once: true })
  conn.controller.signal.addEventListener('abort', onDisconnect, { once: true })
  const timer = setTimeout(() => cancel('MCP 请求超时'), timeoutMs)
  timer.unref?.()
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...conn.headers,
    }
    if (conn.sessionId) headers['mcp-session-id'] = conn.sessionId
    sent = true
    const res = await undiciFetch(conn.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: ac.signal,
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) conn.sessionId = sid
    if (res.status === 202) return null // 通知的应答
    if (!res.ok) {
      if (res.status === 404) conn.sessionId = undefined // 会话被服务器回收，下次请求重新握手
      throw new Error(`MCP HTTP ${res.status}`)
    }
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('text/event-stream') && res.body) {
      const want = (msg as { id?: number }).id
      for await (const data of sseData(res.body)) {
        if (want == null) continue // 通知不等服务端响应
        let m: RpcResult
        try {
          m = JSON.parse(data) as RpcResult
        } catch {
          continue
        }
        if (m.id === want) {
          if (m.error) throw new Error(m.error.message ?? 'MCP 服务器返回错误')
          return m.result ?? {}
        }
      }
      throw new Error('MCP SSE 流在返回响应前结束')
    }
    const body = (await res.json()) as RpcResult
    if (msg.id != null && body.id !== msg.id) throw new Error('MCP 返回了不匹配的请求 id')
    if (body.error) throw new Error(body.error.message ?? 'MCP 服务器返回错误')
    return body.result ?? {}
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    conn.controller.signal.removeEventListener('abort', onDisconnect)
  }
}

function httpRpc<T = Record<string, unknown>>(
  conn: HttpConn,
  method: string,
  params: unknown,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<T> {
  const id = ++conn.nextId
  const msg: Record<string, unknown> = { jsonrpc: '2.0', id, method }
  if (params !== undefined) msg.params = params
  return httpExchange(conn, msg, timeoutMs, signal) as Promise<T>
}

async function connectHttp(name: string, cfg: Pick<MCPServerConfig, 'url' | 'headers'>): Promise<void> {
  const conn: HttpConn = {
    kind: 'http',
    name,
    url: cfg.url ?? '',
    headers: cfg.headers ?? {},
    nextId: 0,
    tools: [],
    status: 'error',
    controller: new AbortController(),
  }
  connections.set(name, conn)
  try {
    await httpRpc(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'StableWorker', version: '0.9.5' },
    })
    await httpExchange(conn, { jsonrpc: '2.0', method: 'notifications/initialized' }, 15_000)
    const tl = await httpRpc<{ tools?: McpTool[] }>(conn, 'tools/list', undefined)
    conn.tools = tl.tools ?? []
    conn.status = 'connected'
    conn.error = undefined
  } catch (e) {
    conn.status = 'error'
    conn.error = (e as Error).message
    throw e
  }
}

// ---------- 连接管理 ----------

/** 连接一台 MCP 服务器：握手 + 拉取工具列表（按配置自动选择 stdio / http 传输） */
export async function connectServer(
  name: string,
  cfg: Pick<MCPServerConfig, 'command' | 'url' | 'headers' | 'env'>,
): Promise<void> {
  const expected = generation(name)
  return serialize(() => connectServerNow(name, cfg, expected))
}

async function connectServerNow(name: string, cfg: Pick<MCPServerConfig, 'command' | 'url' | 'headers' | 'env'>, expected = generation(name)): Promise<void> {
  const check = (): void => { if (shuttingDown || expected !== generation(name)) throw new Error('MCP 连接配置已失效') }
  check()
  await disconnectServerNow(name)
  check()
  fingerprints.set(name, fingerprint(cfg))
  if (cfg.url) await connectHttp(name, cfg)
  else await connectStdio(name, cfg)
  if (shuttingDown || expected !== generation(name)) {
    await disconnectServerNow(name)
    throw new Error('MCP 连接配置已失效')
  }
}

export async function disconnectServer(name: string): Promise<void> {
  invalidate(name)
  await disconnectServerNow(name)
}

async function disconnectServerNow(name: string): Promise<void> {
  clearReconnect(name)
  failCounts.delete(name)
  const conn = connections.get(name)
  if (!conn) return
  connections.delete(name)
  fingerprints.delete(name)
  conn.status = 'error'
  conn.tools = []
  if (conn.kind === 'http') conn.controller.abort()
  else {
    for (const p of conn.pending.values()) p.reject(new Error('MCP 服务器已断开'))
    conn.pending.clear()
  }
  if (conn.kind === 'stdio' && !conn.child.killed) killTree(conn.child)
}

/** 对比配置：连接新服务器、断开已移除的（幂等，每次对话开始调用） */
export async function ensureMcpConnections(
  configs: MCPServerConfig[],
): Promise<void> {
  const snapshot = structuredClone(configs)
  const previous = currentConfigs
  for (const cfg of snapshot) {
    const old = previous.find((c) => c.name === cfg.name)
    if (!old || old.disabled !== cfg.disabled || fingerprint(old) !== fingerprint(cfg)) invalidate(cfg.name)
  }
  for (const old of previous) if (!snapshot.some((c) => c.name === old.name)) invalidate(old.name)
  currentConfigs = snapshot
  // Stop removed/disabled servers immediately, even while another handshake waits.
  for (const name of [...connections.keys()]) {
    if (!snapshot.some((c) => c.name === name && !c.disabled && fingerprints.get(name) === fingerprint(c))) await disconnectServer(name)
  }
  return serialize(async () => {
    if (shuttingDown) return
    for (const cfg of snapshot) {
      if (!currentConfigs.some((c) => c.name === cfg.name && !c.disabled && fingerprint(c) === fingerprint(cfg))) continue
      if (cfg.disabled) continue
      const existing = connections.get(cfg.name)
      if (existing?.status === 'connected' && fingerprints.get(cfg.name) === fingerprint(cfg)) continue
      try {
        await connectServerNow(cfg.name, cfg)
        failCounts.delete(cfg.name)
      } catch {
        failCounts.set(cfg.name, (failCounts.get(cfg.name) ?? 0) + 1)
        scheduleReconnect(cfg.name)
      }
    }
  })
}

/** 统一的请求入口：按连接类型分发 */
function request<T = Record<string, unknown>>(
  conn: Conn,
  method: string,
  params: unknown,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<T> {
  return conn.kind === 'stdio'
    ? stdioRequest<T>(conn, method, params, timeoutMs, signal)
    : httpRpc<T>(conn, method, params, timeoutMs, signal)
}

/** 收集所有已连接服务器的工具（mcp__服务器__工具 命名，需批准、无超时） */
export function getMcpToolDefs(): ToolDefinition[] {
  const defs: ToolDefinition[] = []
  for (const conn of connections.values()) {
    if (conn.status !== 'connected') continue
    for (const t of conn.tools) {
      defs.push({
        name: `mcp__${conn.name}__${t.name}`,
        description: (t.description ?? '') + `（MCP 服务器：${conn.name}）`,
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
        timeoutMs: Number.POSITIVE_INFINITY,
        requiresApproval: true,
        async execute(input, ctx) {
          if (connections.get(conn.name) !== conn || conn.status !== 'connected') throw new Error('MCP 连接已更新或断开，请重新获取工具')
          const res = await request(conn, 'tools/call', { name: t.name, arguments: input }, 180_000, ctx.signal)
          const parts = (res.content as Array<{ type?: string; text?: string }> | undefined) ?? []
          const text = parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('\n')
          const isError = (res as { isError?: boolean }).isError === true
          return { content: text || '（空响应）', isError }
        },
      })
    }
  }
  return defs
}

export function getMcpStatus(): McpServerStatus[] {
  return [...connections.values()].map((c) => ({
    name: c.name,
    kind: c.kind,
    status: c.status,
    error: c.error,
    toolCount: c.tools.length,
  }))
}

// ---------- resources（资源浏览） ----------

export async function listMcpResources(name: string): Promise<McpResourceMeta[]> {
  const conn = connections.get(name)
  if (!conn || conn.status !== 'connected') throw new Error('服务器未连接')
  const res = await request<{ resources?: McpResourceMeta[] }>(conn, 'resources/list', {})
  return res.resources ?? [] // v1 只取第一页（cursor 分页不做）
}

export async function readMcpResource(name: string, uri: string): Promise<McpResourceContent[]> {
  const conn = connections.get(name)
  if (!conn || conn.status !== 'connected') throw new Error('服务器未连接')
  const res = await request<{
    contents?: Array<{ mimeType?: string; text?: string; blob?: string }>
  }>(conn, 'resources/read', { uri })
  return (res.contents ?? []).map((c) => ({
    mimeType: c.mimeType,
    text: c.text ?? (c.blob ? `（base64 内容 ${c.blob.length} 字符，未解码）` : '（空）'),
  }))
}

// ---------- 进程收尾与 IPC ----------

/** 进程退出前杀掉全部 MCP 服务器子进程（并停掉自动重连） */
export function killAllMcpServers(): void {
  shuttingDown = true
  for (const name of [...reconnectTimers.keys()]) clearReconnect(name)
  for (const conn of connections.values()) {
    if (conn.kind === 'stdio') {
      for (const p of conn.pending.values()) p.reject(new Error('应用正在退出'))
      conn.pending.clear()
      killTree(conn.child)
    } else conn.controller.abort()
  }
  connections.clear()
  fingerprints.clear()
}

/** 测试与诊断用：各 stdio 服务器的子进程 pid */
export function mcpConnectionPids(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const conn of connections.values()) {
    if (conn.kind === 'stdio' && conn.child.pid) out[conn.name] = conn.child.pid
  }
  return out
}

/** MCP 资源双工具：让模型能列出/读取已连接服务器的 resources（对齐 Claude Code 的 ListMcpResources / ReadMcpResource） */
const resourceTools: ToolDefinition[] = [
  {
    name: 'mcp_list_resources',
    description:
      '列出已连接 MCP 服务器的 resources（资源）。server 省略时列出全部服务器的资源；' +
      '指定 server 时只列该服务器的。返回 URI / 名称 / 类型 / 描述。拿到 URI 后可用 mcp_read_resource 读取内容。',
    inputSchema: {
      type: 'object',
      properties: { server: { type: 'string', description: '可选：只列这一台服务器（服务器名）' } },
    },
    kind: 'read',
    timeoutMs: 15_000,
    async execute(input) {
      const server = typeof input.server === 'string' ? input.server.trim() : ''
      const names = server ? [server] : getMcpStatus().filter((x) => x.status === 'connected').map((x) => x.name)
      if (names.length === 0) return { content: server ? `服务器 ${server} 未连接` : '当前没有已连接的 MCP 服务器', isError: true }
      const lines: string[] = []
      for (const name of names) {
        try {
          const list = await listMcpResources(name)
          lines.push(list.length === 0 ? `${name}：无资源` : `${name}：\n` + list.map((r) => `- [${r.uri}] ${r.name ?? ''}${r.mimeType ? ` (${r.mimeType})` : ''}${r.description ? ` — ${r.description}` : ''}`).join('\n'))
        } catch (e) {
          lines.push(`${name}：列出失败（${e instanceof Error ? e.message : String(e)}）`)
        }
      }
      return { content: lines.join('\n') }
    },
  },
  {
    name: 'mcp_read_resource',
    description: '读取一个 MCP 资源的内容（文本部分）。server 为服务器名，uri 用 mcp_list_resources 拿到的资源 URI。',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务器名' },
        uri: { type: 'string', description: '资源 URI' },
      },
      required: ['server', 'uri'],
    },
    kind: 'read',
    timeoutMs: 15_000,
    async execute(input) {
      const server = typeof input.server === 'string' ? input.server.trim() : ''
      const uri = typeof input.uri === 'string' ? input.uri.trim() : ''
      if (!server || !uri) return { content: '需要 server 与 uri 参数', isError: true }
      const contents = await readMcpResource(server, uri)
      const text = contents.map((c) => c.text).join('; ')
      return { content: text || '（资源内容为空）' }
    },
  },
]

export function getResourceTools(): ToolDefinition[] {
  return resourceTools
}

/** 渲染进程可见的完整视图：配置 + 实时状态 */
export interface McpAllResult {
  servers: MCPServerConfig[]
  status: McpServerStatus[]
}

function cleanKV(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = k.trim()
    if (key) out[key] = String(v ?? '')
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 设置页的 IPC：读取 / 保存（保存即按新配置 diff 连接）/ 强制重连 / 资源浏览 */
export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:getAll', async (): Promise<McpAllResult> => {
    const cfg = await loadConfig()
    return { servers: cfg.mcpServers ?? [], status: getMcpStatus() }
  })

  ipcMain.handle('mcp:saveServers', async (_e, servers: MCPServerConfig[]): Promise<McpAllResult> => {
    const clean = (Array.isArray(servers) ? servers : [])
      .map((s) => ({
        name: String(s.name ?? '').trim(),
        command: String(s.command ?? '').trim(),
        url: String(s.url ?? '').trim(),
        headers: cleanKV(s.headers),
        env: cleanKV(s.env),
        disabled: s.disabled === true,
      }))
      .filter((s) => s.name && (s.command || s.url))
    const cfg = await loadConfig()
    cfg.mcpServers = clean
    await saveConfig(cfg)
    await ensureMcpConnections(clean)
    return { servers: clean, status: getMcpStatus() }
  })

  ipcMain.handle('mcp:reconnect', async (_e, name: string): Promise<McpServerStatus[]> => {
    const cfg = await loadConfig()
    const target = (cfg.mcpServers ?? []).find((s) => s.name === name)
    if (target && !target.disabled) {
      await connectServer(target.name, target).catch(() => {})
    }
    return getMcpStatus()
  })

  ipcMain.handle('mcp:listResources', async (_e, name: string) => {
    try {
      return { ok: true, resources: await listMcpResources(name) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, resources: [] as McpResourceMeta[] }
    }
  })

  ipcMain.handle('mcp:readResource', async (_e, name: string, uri: string) => {
    try {
      return { ok: true, contents: await readMcpResource(name, uri) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, contents: [] as McpResourceContent[] }
    }
  })
}
