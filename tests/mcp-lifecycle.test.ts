import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connectServer, disconnectServer, ensureMcpConnections, getMcpToolDefs, getMcpStatus } from '../src/main/mcp'

const servers: Server[] = []
afterEach(async () => {
  await ensureMcpConnections([])
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})

async function fixture(prefix: string, slowInit = false) {
  let finishInit: (() => void) | undefined
  let started!: () => void
  const initialized = new Promise<void>((resolve) => { started = resolve })
  let accepted!: () => void
  const called = new Promise<void>((resolve) => { accepted = resolve })
  let cancelled!: (id: number) => void
  const cancellation = new Promise<number>((resolve) => { cancelled = resolve })
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', (part) => { data += String(part) })
    req.on('end', () => {
      const msg = JSON.parse(data) as { id: number; method: string; params: { requestId?: number; arguments?: { wait?: boolean } } }
      const reply = (result: unknown): void => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result })) }
      if (msg.method === 'initialize') {
        finishInit = () => reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: prefix, version: '1' } })
        started()
        if (!slowInit) finishInit()
      } else if (msg.method === 'tools/list') reply({ tools: [{ name: 'echo', inputSchema: {} }] })
      else if (msg.method === 'tools/call') {
        accepted()
        if (!msg.params.arguments?.wait) reply({ content: [{ type: 'text', text: `${prefix}:${req.headers['x-fixture'] ?? ''}` }] })
        else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': pending\n\n') }
      } else {
        if (msg.method === 'notifications/cancelled') cancelled(msg.params.requestId!)
        res.writeHead(202); res.end()
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  servers.push(server)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, initialized, called, cancellation, release: () => finishInit?.() }
}

describe('MCP HTTP生命周期', () => {
  it('同名URL和headers变更都生效，移除后不再开放旧工具', async () => {
    const a = await fixture('a'), b = await fixture('b')
    const invoke = async () => getMcpToolDefs()[0].execute({}, { projectPath: '.' })
    await ensureMcpConnections([{ name: 'http', url: a.url, headers: { 'x-fixture': 'one' } }])
    expect((await invoke()).content).toBe('a:one')
    await ensureMcpConnections([{ name: 'http', url: b.url, headers: { 'x-fixture': 'two' } }])
    expect((await invoke()).content).toBe('b:two')
    await ensureMcpConnections([{ name: 'http', url: b.url, headers: { 'x-fixture': 'three' } }])
    expect((await invoke()).content).toBe('b:three')
    await ensureMcpConnections([])
    expect(getMcpToolDefs()).toEqual([])
  })
  it('HTTP取消终止流读取并通知服务端取消原请求', async () => {
    const srv = await fixture('cancel')
    await connectServer('cancel-http', { url: srv.url })
    const controller = new AbortController()
    const request = getMcpToolDefs()[0].execute({ wait: true }, { projectPath: '.', signal: controller.signal })
    const rejected = expect(request).rejects.toThrow('取消')
    await srv.called
    controller.abort()
    await rejected
    expect(await srv.cancellation).toBeGreaterThan(0)
    await disconnectServer('cancel-http')
  })
  it('排队重连期间禁用配置使旧尝试失效，连接不会复活', async () => {
    const blocker = await fixture('blocker', true), old = await fixture('old')
    const config = [{ name: 'old', url: old.url }]
    await ensureMcpConnections(config)
    const blocking = connectServer('blocking', { url: blocker.url })
    await blocker.initialized
    const queued = connectServer('old', config[0])
    const rejected = expect(queued).rejects.toThrow('失效')
    const disabled = ensureMcpConnections([{ ...config[0], disabled: true }])
    blocker.release()
    await blocking.catch(() => {})
    await rejected
    await disabled
    expect(getMcpStatus().some((server) => server.name === 'old')).toBe(false)
    expect(getMcpToolDefs().some((tool) => tool.name.includes('__old__'))).toBe(false)
  })
})
