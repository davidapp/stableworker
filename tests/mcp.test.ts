import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  connectServer,
  disconnectServer,
  ensureMcpConnections,
  getMcpStatus,
  getMcpToolDefs,
  listMcpResources,
  mcpConnectionPids,
  readMcpResource,
} from '../src/main/mcp'

const serverCmd = `"${process.execPath}" ${path.resolve(__dirname, '../scripts/test-mcp-echo.mjs')}`

describe('MCP stdio 客户端', () => {
  it('握手 + 工具列表 + 工具调用 全链路', async () => {
    await connectServer('test-echo', { command: serverCmd })
    const defs = getMcpToolDefs()
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('mcp__test-echo__echo')
    expect(defs[0].requiresApproval).toBe(true)

    const r = await defs[0].execute({ text: '你好' }, { projectPath: '.' })
    expect(r.content).toBe('echo: 你好')
    expect(r.isError).toBe(false)

    const st = getMcpStatus()
    expect(st[0].status).toBe('connected')
    expect(st[0].toolCount).toBe(1)
    await disconnectServer('test-echo')
    expect(getMcpToolDefs()).toHaveLength(0)
  })

  it('env 环境变量传给子进程', async () => {
    await connectServer('test-env', { command: serverCmd, env: { MCP_TEST_VAR: 'hello-env' } })
    const def = getMcpToolDefs().find((d) => d.name === 'mcp__test-env__echo')
    expect(def).toBeTruthy()
    const r = await def!.execute({ text: 'x', envKey: 'MCP_TEST_VAR' }, { projectPath: '.' })
    expect(r.content).toBe('echo: x env=hello-env')
    await disconnectServer('test-env')
  })

  it('进程被杀后自动重连（退避 5s）', async () => {
    await ensureMcpConnections([{ name: 'test-reconn', command: serverCmd }])
    expect(getMcpStatus().find((s) => s.name === 'test-reconn')?.status).toBe('connected')
    const pid = mcpConnectionPids()['test-reconn']
    expect(pid).toBeTruthy()
    process.kill(pid, 'SIGKILL')

    // 退避 5s 后应自动恢复 connected 且工具列表重新拉取
    const deadline = Date.now() + 15_000
    let recovered = false
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      const st = getMcpStatus().find((s) => s.name === 'test-reconn')
      if (st?.status === 'connected' && st.toolCount === 1) {
        recovered = true
        break
      }
    }
    expect(recovered).toBe(true)
    await disconnectServer('test-reconn')
  }, 25_000)
})

/** 内联 Streamable HTTP 测试服务器：tools/call 故意走 SSE 响应，覆盖客户端 SSE 解析路径 */
function startHttpFixture(): Promise<{ url: string; server: Server }> {
  const sessions = new Set<string>()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d: Buffer) => (body += d.toString('utf8')))
    req.on('end', () => {
      let msg: { id?: number; method?: string; params?: { arguments?: Record<string, unknown>; uri?: string } }
      try {
        msg = JSON.parse(body)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      const rawSid = req.headers['mcp-session-id']
      const sid = Array.isArray(rawSid) ? rawSid[0] : rawSid
      if (msg.method !== 'initialize' && (!sid || !sessions.has(sid))) {
        res.writeHead(404)
        res.end()
        return
      }
      const replyJson = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      }
      if (msg.method === 'initialize') {
        const ns = 'sid-' + Math.random().toString(36).slice(2)
        sessions.add(ns)
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': ns })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: 'test-http', version: '1.0.0' },
            },
          }),
        )
      } else if (msg.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
      } else if (msg.method === 'tools/list') {
        replyJson({
          tools: [
            {
              name: 'echo',
              description: '回显输入文本',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            },
          ],
        })
      } else if (msg.method === 'tools/call') {
        const a = msg.params?.arguments ?? {}
        // SSE 流式响应：第一个事件是无关通知，第二个才是匹配 id 的响应
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n')
        res.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: 'echo: ' + (a.text ?? '') }], isError: false },
          })}\n\n`,
        )
        res.end()
      } else if (msg.method === 'resources/list') {
        replyJson({
          resources: [{ uri: 'memo://hello', name: 'hello', description: '测试资源', mimeType: 'text/plain' }],
        })
      } else if (msg.method === 'resources/read') {
        replyJson({ contents: [{ uri: msg.params?.uri, mimeType: 'text/plain', text: 'world' }] })
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unknown method' } }))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${addr.port}/mcp`, server })
    })
  })
}

describe('MCP Streamable HTTP 客户端', () => {
  it('握手 + 工具调用（SSE 响应）+ 资源浏览 全链路', async () => {
    const srv = await startHttpFixture()
    try {
      await connectServer('test-http', { url: srv.url })
      const def = getMcpToolDefs().find((d) => d.name === 'mcp__test-http__echo')
      expect(def).toBeTruthy()
      expect(def!.requiresApproval).toBe(true)
      const r = await def!.execute({ text: 'ping' }, { projectPath: '.' })
      expect(r.content).toBe('echo: ping')

      const st = getMcpStatus().find((s) => s.name === 'test-http')
      expect(st?.kind).toBe('http')
      expect(st?.status).toBe('connected')

      const resources = await listMcpResources('test-http')
      expect(resources).toHaveLength(1)
      expect(resources[0].uri).toBe('memo://hello')
      const contents = await readMcpResource('test-http', 'memo://hello')
      expect(contents[0].text).toBe('world')

      await disconnectServer('test-http')
    } finally {
      await new Promise<void>((done) => srv.server.close(() => done()))
    }
  })
})
