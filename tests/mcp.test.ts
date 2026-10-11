import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { connectServer, disconnectServer, getMcpStatus, getMcpToolDefs } from '../src/main/mcp'

const serverCmd = `"${process.execPath}" ${path.resolve(__dirname, '../scripts/test-mcp-echo.mjs')}`

describe('MCP stdio 客户端', () => {
  it('握手 + 工具列表 + 工具调用 全链路', async () => {
    await connectServer('test-echo', serverCmd)
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
})
