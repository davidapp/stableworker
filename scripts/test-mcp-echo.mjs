// 最小 MCP 测试服务器（stdio JSON-RPC）：供 tests/mcp.test.ts 做真实协议验证
let buf = ''
let cancelledCount = 0
const delayed = new Map()
process.stdin.on('data', (d) => {
  buf += d.toString('utf8')
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.method === 'initialize') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'test-echo', version: '1.0.0' },
          },
        }) + '\n',
      )
    } else if (msg.method === 'notifications/initialized') {
      // 通知，无响应
    } else if (msg.method === 'tools/list') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'echo',
                description: '回显输入文本',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
              },
            ],
          },
        }) + '\n',
      )
    } else if (msg.method === 'notifications/cancelled') {
      const timer = delayed.get(msg.params.requestId)
      if (timer) { clearTimeout(timer); delayed.delete(msg.params.requestId); cancelledCount++ }
    } else if (msg.method === 'tools/call') {
      const a = (msg.params && msg.params.arguments) || {}
      const extra = a.envKey ? ` env=${process.env[a.envKey] ?? ''}` : ''
      const reply = () => process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: 'echo: ' + (a.text ?? '') + extra + (a.cancelCount ? ` cancelled=${cancelledCount}` : '') }],
            isError: a.text === 'fail',
          },
        }) + '\n',
      )
      if (a.delay) delayed.set(msg.id, setTimeout(() => { delayed.delete(msg.id); reply() }, a.delay))
      else reply()
    } else if (msg.id != null) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unknown method' } }) + '\n')
    }
  }
})
