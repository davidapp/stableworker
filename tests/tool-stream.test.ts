import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatRequest } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  events: [] as ChatEvent[],
  fetch: vi.fn(),
  runTool: vi.fn(),
  snapshot: vi.fn(),
  cfg: {
    llmProfiles: [{ id: 'llm', apiKey: 'fixture', provider: 'openai-compatible', name: 'Fixture', model: 'fixture-model', baseURL: 'https://example.test/v1', proxyURL: '' }],
    activeLlmId: 'llm',
    projects: [{ id: 'project', path: '/fixture-project' }],
    approvalMode: 'fullAccess',
    contextLimit: 0,
  },
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_channel: string, event: ChatEvent) => fixture.events.push(event) } }] },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => fixture.handlers.set(channel, handler) },
}))
vi.mock('undici', () => ({ fetch: fixture.fetch, ProxyAgent: class {} }))
vi.mock('../src/main/config', () => ({ loadConfig: async () => fixture.cfg, decryptApiKey: () => 'fixture-key' }))
vi.mock('../src/main/debug', () => ({
  beginExchange: () => ({ inputTokens: null }),
  maskHeaders: (headers: unknown) => headers,
  recordStatus: vi.fn(), recordSSELine: vi.fn(), recordUsageEvent: vi.fn(), recordAssembledText: vi.fn(),
  recordReasoningText: vi.fn(), recordToolCalls: vi.fn(), endExchange: vi.fn(), recordContextBreakdown: vi.fn(),
}))
vi.mock('../src/main/tools', () => ({
  getToolDefinitions: () => [
    { name: 'read_file', description: 'Fixture read', inputSchema: {}, kind: 'read', execute: vi.fn() },
    { name: 'edit_file', description: 'Fixture edit', inputSchema: {}, kind: 'edit', requiresApproval: true, execute: vi.fn() },
  ],
  runToolUseBlock: fixture.runTool,
}))
vi.mock('../src/main/approvals', () => ({ requestApproval: vi.fn(), resolveSessionApprovals: vi.fn(), requestUserInput: vi.fn(), resolveSessionUserInputs: vi.fn() }))
vi.mock('../src/main/fileHistory', () => ({ snapshotFilesBeforeChange: fixture.snapshot, sessionCheckpointsRoot: () => '/fixture-checkpoints' }))
vi.mock('../src/main/compact', () => ({ mergeSummaryIntoFirstUser: vi.fn(), summarizeWithModel: vi.fn(), worthSummarizing: () => false, getCachedCompact: () => undefined, setCachedCompact: vi.fn() }))
vi.mock('../src/main/sessions', () => ({ appendSummaryLine: vi.fn() }))
vi.mock('../src/main/agentsMd', () => ({ loadAgentsMd: async () => '' }))
vi.mock('../src/main/mcp', () => ({ ensureMcpConnections: async () => {}, getMcpToolDefs: () => [] }))

import { registerChatHandlers } from '../src/main/llm'

const request: ChatRequest = { sessionId: 'session', projectId: 'project', messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Read the fixture files' }] }] }

function response(toolIds: string[], name = 'read_file') {
  const event = toolIds.length
    ? { choices: [{ delta: { tool_calls: toolIds.map((id, index) => ({ index, id, function: { name, arguments: '{"path":"src/app/page.tsx","offset":20}' } })) }, finish_reason: 'tool_calls' }] }
    : { choices: [{ delta: { content: 'Fixture report' }, finish_reason: 'stop' }] }
  let sent = false
  return {
    ok: true, status: 200, headers: new Headers(),
    body: { getReader: () => ({ read: async () => {
      if (sent) return { done: true }
      sent = true
      return { done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`) }
    } }) },
  }
}

async function send() {
  return fixture.handlers.get('chat:send')!(null, request) as Promise<{ ok: boolean; error?: string }>
}

beforeEach(() => {
  fixture.events.length = 0
  fixture.handlers.clear()
  fixture.fetch.mockReset()
  fixture.runTool.mockReset().mockResolvedValue({ content: 'Fixture file contents', isError: false, durationMs: 1 })
  fixture.snapshot.mockReset().mockResolvedValue(undefined)
  registerChatHandlers()
})

describe('主代理工具流与结束状态', () => {
  it('第八轮 read_file 仍然执行，下一请求中的工具结果不重复', async () => {
    let round = 0
    fixture.fetch.mockImplementation(async () => response(++round <= 8 ? [`call-${round}`] : []))
    expect(await send()).toEqual({ ok: true, compacted: undefined })
    expect(fixture.runTool).toHaveBeenCalledTimes(8)
    expect(fixture.events.filter((e) => e.type === 'tool_result')).toHaveLength(8)
    expect(fixture.events.some((e) => e.type === 'tool_result' && e.toolUseId === 'call-8')).toBe(true)
    fixture.fetch.mock.calls.forEach(([, options], index) => {
      const body = JSON.parse(options.body)
      const results = body.messages.filter((m: { role: string }) => m.role === 'tool')
      expect(results).toHaveLength(index)
      expect(new Set(results.map((m: { tool_call_id: string }) => m.tool_call_id)).size).toBe(index)
    })
    expect(fixture.runTool.mock.calls[0][2]).toMatchObject({ sessionId: 'session', definition: { name: 'read_file' } })
  })

  it('上限末轮工具完成后移除工具定义并汇总，所有卡片都有终态', async () => {
    let round = 0
    fixture.fetch.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body)
      round++
      if (round === 51) {
        expect(body.tools).toBeUndefined()
        expect(body.messages.filter((m: { role: string }) => m.role === 'tool')).toHaveLength(50)
        expect(body.messages.at(-1).content).toContain('未完成')
        return response([])
      }
      return response([`call-${round}`])
    })
    expect((await send()).ok).toBe(true)
    expect(round).toBe(51)
    expect(fixture.runTool).toHaveBeenCalledTimes(50)
    const results = fixture.events.filter((e) => e.type === 'tool_result')
    expect(results).toHaveLength(50)
    expect(fixture.events.at(-1)?.type).toBe('done')
  })

  it('服务端在收尾轮仍请求工具时显式报错，不留下运行中的卡片', async () => {
    let round = 0
    fixture.fetch.mockImplementation(async () => response([`call-${++round}`]))
    expect((await send()).ok).toBe(false)
    expect(fixture.runTool).toHaveBeenCalledTimes(50)
    expect(fixture.events.filter((e) => e.type === 'tool_result')).toHaveLength(51)
    expect(fixture.events.at(-2)).toMatchObject({ type: 'tool_result', toolUseId: 'call-51', isError: true })
    expect(fixture.events.at(-1)?.type).toBe('error')
  })

  it('工具门禁发生异常时，尚未执行的同轮工具都收到错误终态', async () => {
    fixture.fetch.mockResolvedValue(response(['edit-a', 'edit-b'], 'edit_file'))
    fixture.snapshot.mockRejectedValue(new Error('Fixture checkpoint unavailable'))
    expect((await send()).ok).toBe(false)
    expect(fixture.runTool).not.toHaveBeenCalled()
    expect(fixture.events.filter((e) => e.type === 'tool_result')).toEqual([
      expect.objectContaining({ toolUseId: 'edit-a', isError: true }),
      expect.objectContaining({ toolUseId: 'edit-b', isError: true }),
    ])
  })

  it('并行工具中一个失败时，等待另一调用收尾再结束会话', async () => {
    let completeSecond!: (result: { content: string; isError: boolean; durationMs: number }) => void
    fixture.fetch.mockResolvedValue(response(['read-a', 'read-b']))
    fixture.runTool
      .mockRejectedValueOnce(new Error('Fixture execution failure'))
      .mockImplementationOnce(() => new Promise((resolve) => { completeSecond = resolve }))
    const result = send()
    await vi.waitFor(() => expect(fixture.runTool).toHaveBeenCalledTimes(2))
    expect(fixture.events.some((event) => event.type === 'error')).toBe(false)
    completeSecond({ content: 'Second read complete', isError: false, durationMs: 1 })
    expect((await result).ok).toBe(false)
    expect(fixture.events.filter((event) => event.type === 'tool_result')).toEqual([
      expect.objectContaining({ toolUseId: 'read-b', isError: false }),
      expect.objectContaining({ toolUseId: 'read-a', isError: true }),
    ])
    expect(fixture.events.at(-1)?.type).toBe('error')
  })
})
