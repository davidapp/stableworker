import { spawn, type ChildProcess } from 'node:child_process'
import { ipcMain } from 'electron'
import { loadConfig, saveConfig } from './config'
import type { ToolDefinition } from './tools/index'
import type { MCPServerConfig, McpServerStatus } from '../shared/types'

/**
 * 最小 MCP（Model Context Protocol）客户端：stdio 传输，换行分隔 JSON-RPC 2.0。
 * 手写实现（不依赖 @modelcontextprotocol/sdk，规避 ESM 打包问题）：
 *   initialize 握手 → notifications/initialized → tools/list → tools/call。
 * 每台服务器一个子进程；服务器崩溃标记 error，下次对话开始时自动重连。
 */

export interface McpTool {
  name: string
  description?: string
  inputSchema: unknown
}

export interface McpConnection {
  name: string
  status: 'connected' | 'error'
  error?: string
  tools: McpTool[]
  toolCount: number
}

interface Conn {
  name: string
  child: ChildProcess
  buffer: string
  nextId: number
  pending: Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>
  tools: McpTool[]
  status: 'connected' | 'error'
  error?: string
}

/** 命令行分词：支持双引号包裹含空格的参数 */
export function tokenize(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of command.trim()) {
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

function send(conn: Conn, msg: Record<string, unknown>): void {
  conn.child.stdin?.write(JSON.stringify(msg) + '\n')
}

function request<T = Record<string, unknown>>(
  conn: Conn,
  method: string,
  params: unknown,
  timeoutMs = 15_000,
): Promise<T> {
  const id = ++conn.nextId
  return new Promise<T>((resolve, reject) => {
    conn.pending.set(id, {
      resolve: resolve as (v: Record<string, unknown>) => void,
      reject,
    })
    send(conn, { jsonrpc: '2.0', id, method, params })
    const t = setTimeout(() => {
      if (conn.pending.delete(id)) reject(new Error(`MCP 请求超时：${method}`))
    }, timeoutMs)
    t.unref?.()
  })
}

function handleLine(conn: Conn, line: string): void {
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

function wireOutput(conn: Conn): void {
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

/** 连接一台 MCP 服务器：握手 + 拉取工具列表 */
export async function connectServer(name: string, command: string): Promise<void> {
  await disconnectServer(name)
  const child = spawn(tokenize(command)[0], tokenize(command).slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const conn: Conn = {
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

  // spawn 失败（可执行文件不存在等）：拒绝全部挂起请求并标记错误
  conn.child.on('error', (err: Error) => {
    conn.status = 'error'
    conn.error = err.message
    for (const p of conn.pending.values()) p.reject(new Error('MCP 服务器启动失败：' + err.message))
  })
  child.on('exit', () => {
    if (connections.get(name) === conn) {
      conn.status = 'error'
      conn.error = '进程已退出'
      conn.tools = []
    }
  })

  await request(conn, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'StableWorker', version: '0.9.0' },
  })
  send(conn, { jsonrpc: '2.0', method: 'notifications/initialized' })
  const tl = await request<{ tools?: McpTool[] }>(conn, 'tools/list', undefined, 15_000)
  conn.tools = tl.tools ?? []
  conn.status = 'connected'
}

export async function disconnectServer(name: string): Promise<void> {
  const conn = connections.get(name)
  if (!conn) return
  connections.delete(name)
  if (!conn.child.killed) killTree(conn.child)
}

/** 对比配置：连接新服务器、断开已移除的（幂等，每次对话开始调用） */
export async function ensureMcpConnections(
  configs: MCPServerConfig[],
): Promise<void> {
  for (const cfg of configs) {
    if (cfg.disabled) continue
    if (!connections.has(cfg.name)) {
      try {
        await connectServer(cfg.name, cfg.command)
      } catch {
        // 连接失败保持 error 状态，工具池跳过
      }
    }
  }
  for (const name of [...connections.keys()]) {
    if (!configs.some((c) => c.name === name)) await disconnectServer(name)
  }
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
        async execute(input: Record<string, unknown>) {
          const res = await request(conn, 'tools/call', { name: t.name, arguments: input }, 180_000)
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
    status: c.status,
    error: c.error,
    toolCount: c.tools.length,
  }))
}

/** 渲染进程可见的完整视图：配置 + 实时状态 */
export interface McpAllResult {
  servers: MCPServerConfig[]
  status: McpServerStatus[]
}

/** 设置页的 IPC：读取 / 保存（保存即按新配置 diff 连接）/ 强制重连 */
export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:getAll', async (): Promise<McpAllResult> => {
    const cfg = await loadConfig()
    return { servers: cfg.mcpServers ?? [], status: getMcpStatus() }
  })

  ipcMain.handle('mcp:saveServers', async (_e, servers: MCPServerConfig[]): Promise<McpAllResult> => {
    const clean = (Array.isArray(servers) ? servers : [])
      .map((s) => ({ name: String(s.name ?? '').trim(), command: String(s.command ?? '').trim(), disabled: s.disabled === true }))
      .filter((s) => s.name && s.command)
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
      await connectServer(target.name, target.command).catch(() => {})
    }
    return getMcpStatus()
  })
}

/** 进程退出前杀掉全部 MCP 服务器子进程 */
export function killAllMcpServers(): void {
  for (const conn of connections.values()) killTree(conn.child)
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
}
