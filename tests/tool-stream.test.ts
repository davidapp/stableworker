import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatRequest } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  events: [] as ChatEvent[],
  fetch: vi.fn(),
  runTool: vi.fn(),
  snapshot: vi.fn(),
  loadSession: vi.fn(),
  ensureMcp: vi.fn(),
  cfg: {
    llmProfiles: [{ id: 'llm', apiKey: 'fixture', provider: 'openai-compatible', name: 'Fixture', model: 'fixture-model', baseURL: 'https://example.test/v1', proxyURL: '' }],
    activeLlmId: 'llm',
    projects: [{ id: 'project', path: '/fixture-project' }],
    approvalMode: 'fullAccess',
    contextLimit: 0,
    toolSwitches: {} as Record<string, boolean>,
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
vi.mock('../src/main/sessions', () => ({ appendSummaryLine: vi.fn(), loadSessionAny: fixture.loadSession }))
vi.mock('../src/main/agentsMd', () => ({ loadAgentsMd: async () => '' }))
vi.mock('../src/main/mcp', () => ({ ensureMcpConnections: fixture.ensureMcp, getMcpToolDefs: () => [] }))

import { createStreamCollector, LLMStreamError, readSSE, registerChatHandlers } from '../src/main/llm'

const request: ChatRequest = { sessionId: 'session', projectId: 'project', messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Read the fixture files' }] }] }

function response(toolIds: string[], name = 'read_file') {
  const event = toolIds.length
    ? { choices: [{ delta: { tool_calls: toolIds.map((id, index) => ({ index, id, function: { name, arguments: '{"path":"src/app/page.tsx","offset":20}' } })) }, finish_reason: 'tool_calls' }] }
    : { choices: [{ delta: { content: 'Fixture report' }, finish_reason: 'stop' }] }
  return sseResponse(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`)
}

function sseResponse(raw: string | string[]) {
  const chunks = (Array.isArray(raw) ? raw : [raw]).map((chunk) => new TextEncoder().encode(chunk))
  const cancel = vi.fn().mockResolvedValue(undefined)
  const releaseLock = vi.fn()
  let index = 0
  return {
    ok: true, status: 200, headers: new Headers(),
    cancel, releaseLock,
    body: { getReader: () => ({ read: async () => {
      if (index === chunks.length) return { done: true }
      return { done: false, value: chunks[index++] }
    }, cancel, releaseLock }) },
  }
}

const frame = (json: unknown): string => `data: ${JSON.stringify(json)}\n\n`

async function send() {
  return fixture.handlers.get('chat:send')!(null, request) as Promise<{ ok: boolean; error?: string }>
}

beforeEach(() => {
  fixture.events.length = 0
  fixture.handlers.clear()
  fixture.fetch.mockReset()
  fixture.runTool.mockReset().mockResolvedValue({ content: 'Fixture file contents', isError: false, durationMs: 1 })
  fixture.snapshot.mockReset().mockResolvedValue(undefined)
  fixture.loadSession.mockReset().mockResolvedValue({ session: { revision: 8, taskMode: 'coding' } })
  fixture.ensureMcp.mockReset().mockResolvedValue(undefined)
  fixture.cfg.approvalMode = 'fullAccess'
  fixture.cfg.llmProfiles[0].provider = 'openai-compatible'
  fixture.cfg.toolSwitches = {}
  registerChatHandlers()
})
afterEach(() => { vi.useRealTimers() })

describe('主代理工具流与结束状态', () => {
  it('版本已变化的编程会话不启动模型或文件操作', async () => {
    const result = await fixture.handlers.get('chat:send')!(null, { ...request, revision: 7 })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('已被修改') })
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.runTool).not.toHaveBeenCalled()
  })

  it('初始化等待也可立即停止，同一个会话不能同时开始两轮', async () => {
    fixture.ensureMcp.mockImplementation(() => new Promise(() => {}))
    const pending = send()
    await vi.waitFor(() => expect(fixture.ensureMcp).toHaveBeenCalled())
    expect(await send()).toMatchObject({ ok: false, error: expect.stringContaining('已有任务运行') })
    await fixture.handlers.get('chat:stop')!(null, request.sessionId)
    expect(await pending).toEqual({ ok: true })
    expect(fixture.fetch).not.toHaveBeenCalled()
  })
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

describe('工具执行允许列表', () => {
  it.each([
    { name: 'edit_file', mode: 'plan', switches: {} },
    { name: 'read_file', mode: 'fullAccess', switches: { read_file: false } },
    { name: 'unregistered_fixture_tool', mode: 'fullAccess', switches: {} },
    { name: 'task', mode: 'fullAccess', switches: { task: false } },
  ])('$mode 模式拒绝工具 $name；不触发执行、批准或文件快照', async ({ name, mode, switches }) => {
    fixture.cfg.approvalMode = mode
    fixture.cfg.toolSwitches = switches as Record<string, boolean>
    fixture.fetch.mockResolvedValueOnce(response(['blocked'], name)).mockResolvedValueOnce(response([]))
    expect((await send()).ok).toBe(true)
    expect(fixture.runTool).not.toHaveBeenCalled()
    expect(fixture.snapshot).not.toHaveBeenCalled()
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'tool_result', toolUseId: 'blocked', isError: true, content: expect.stringContaining('不在本次允许') }))
    expect(fixture.events.some((event) => event.type === 'approval_request')).toBe(false)
    const body = JSON.parse(fixture.fetch.mock.calls[0][1].body)
    expect(body.tools.some((tool: { function: { name: string } }) => tool.function.name === name)).toBe(false)
  })

  it('Explore 子代理拒绝主代理工具池中的编辑工具', async () => {
    const task = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'task-call', function: { name: 'task', arguments: JSON.stringify({ prompt: 'Fixture research', subagent_type: 'Explore' }) } }] }, finish_reason: 'tool_calls' }] }
    fixture.fetch.mockResolvedValueOnce(sseResponse(frame(task) + 'data: [DONE]\n\n'))
      .mockResolvedValueOnce(response(['forbidden-edit'], 'edit_file'))
      .mockResolvedValueOnce(response([]))
    fixture.runTool.mockImplementationOnce(async (block, path, options) => ({
      ...await options.definition.execute(block.input, { projectPath: path, onOutput: options.onOutput }), durationMs: 1,
    }))
    expect((await send()).ok).toBe(true)
    expect(fixture.runTool).toHaveBeenCalledTimes(1)
    expect(fixture.snapshot).not.toHaveBeenCalled()
    const subRequest = JSON.parse(fixture.fetch.mock.calls[1][1].body)
    expect(subRequest.tools.some((tool: { function: { name: string } }) => tool.function.name === 'edit_file')).toBe(false)
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'tool_result', toolUseId: 'task-call', isError: true, content: expect.stringContaining('不在本轮允许') }))
  })
})

describe('SSE 协议和响应完整性', () => {
  it('支持跨 chunk 的 CRLF、多行 data、注释心跳及 finish_reason 后的 usage', async () => {
    const response = sseResponse([
      ': heartbeat\r\ndata: {"choices": [\r',
      '\ndata: {"delta": {"content": "Fixture"}, "finish_reason": "stop"}]}\r\n\r\n',
      frame({ choices: [], usage: { prompt_tokens: 42 } }),
    ])
    const events: Array<Record<string, unknown> | null> = []
    await readSSE(response.body, (json) => { events.push(json) })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ usage: { prompt_tokens: 42 } })
    expect(response.releaseLock).toHaveBeenCalledOnce()
  })

  it('DONE 结束时取消并释放 reader，避免连接继续读取', async () => {
    const response = sseResponse('data: [DONE]\n\n')
    await readSSE(response.body, () => {})
    expect(response.cancel).toHaveBeenCalledOnce()
    expect(response.releaseLock).toHaveBeenCalledOnce()
  })

  it('处理回调异常向上传播，不误当成 JSON 解析失败或请求成功', async () => {
    const response = sseResponse(frame({ choices: [] }) + 'data: [DONE]\n\n')
    await expect(readSSE(response.body, () => { throw new Error('Fixture handler failure') })).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('Fixture handler failure') })
    expect(response.cancel).toHaveBeenCalledOnce()
    expect(response.releaseLock).toHaveBeenCalledOnce()
  })

  it.each(['{"choices":', '[1,2]', 'null'])('无效 SSE JSON %s 即使后面有 DONE 也必须失败', async (raw) => {
    await expect(readSSE(sseResponse(`data: ${raw}\n\ndata: [DONE]\n\n`).body, () => {})).rejects.toBeInstanceOf(LLMStreamError)
  })

  it.each(['openai-compatible', 'anthropic'] as const)('%s 的服务 error 事件不得成功返回', async (provider) => {
    const raw = frame({ type: 'error', error: { type: 'authentication_error', message: 'Fixture credential failure' } })
    await expect(readSSE(sseResponse(raw).body, () => {}, provider)).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('authentication_error') })
  })

  it('没有终态的提前 EOF 必须失败', async () => {
    await expect(readSSE(sseResponse(frame({ choices: [{ delta: { content: 'Fixture partial' } }] })).body, () => {})).rejects.toThrow('完成标记前中断')
  })

  it('Anthropic 必须收到 message_stop，不能用 OpenAI DONE 代替', async () => {
    await expect(readSSE(sseResponse(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })).body, () => {}, 'anthropic')).rejects.toThrow('完成标记前中断')
    await expect(readSSE(sseResponse('data: [DONE]\n\n').body, () => {}, 'anthropic')).rejects.toThrow('message_stop')
  })

  it('Anthropic 完整工具块和 message_stop 后才显示可执行调用', async () => {
    const events: ChatEvent[] = []
    const collector = createStreamCollector('anthropic', 'session', (event) => events.push(event))
    const raw = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'anthropic-call', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"fixture.tsx"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ].map(frame).join('')
    await readSSE(sseResponse(raw).body, (json) => { if (json) collector.onEvent(json) }, 'anthropic')
    expect(events).toHaveLength(0)
    expect(collector.finish().blocks).toEqual([{ type: 'tool_use', id: 'anthropic-call', name: 'read_file', input: { path: 'fixture.tsx' }, status: 'running' }])
    expect(events).toEqual([expect.objectContaining({ type: 'tool_use', toolUseId: 'anthropic-call' })])
  })

  it('Anthropic 的未关闭工具块即使收到 message_stop 也不可执行', async () => {
    const collector = createStreamCollector('anthropic', 'session', () => {})
    const raw = frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'incomplete-call', name: 'read_file', input: { path: 'fixture.tsx' } } }) + frame({ type: 'message_stop' })
    await readSSE(sseResponse(raw).body, (json) => { if (json) collector.onEvent(json) }, 'anthropic')
    expect(() => collector.finish()).toThrow('内容块 0 未完成')
  })

  it.each(['max_tokens', 'refusal', 'model_context_window_exceeded', undefined])('Anthropic 停止原因 %s 的闭合工具 JSON 也不可执行', (stopReason) => {
    const sink = vi.fn()
    const collector = createStreamCollector('anthropic', 'session', sink)
    collector.onEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'closed', name: 'edit_file', input: { path: 'fixture.tsx' } } })
    collector.onEvent({ type: 'content_block_stop', index: 0 })
    if (stopReason) collector.onEvent({ type: 'message_delta', delta: { stop_reason: stopReason } })
    collector.onEvent({ type: 'message_stop' })
    expect(() => collector.finish()).toThrow('工具响应未正常结束')
    expect(sink).not.toHaveBeenCalled()
  })

  it.each(['', '{"path":', '[]', 'null', '"fixture"'])('参数 %s 不完整或不是对象时整组工具都不发出', (argumentsJson) => {
    const sink = vi.fn()
    const collector = createStreamCollector('openai-compatible', 'session', sink)
    collector.onEvent({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'valid-call', function: { name: 'read_file', arguments: '{"path":"fixture.tsx"}' } },
      { index: 1, id: 'invalid-call', function: { name: 'read_file', arguments: argumentsJson } },
    ] }, finish_reason: 'tool_calls' }] })
    expect(() => collector.finish()).toThrow('参数不完整或不是有效 JSON 对象')
    expect(sink).not.toHaveBeenCalled()
  })

  it('输出 length 截断的工具即使 JSON 完整也不执行', () => {
    const collector = createStreamCollector('openai-compatible', 'session', () => {})
    collector.onEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'truncated-call', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'length' }] })
    expect(() => collector.finish()).toThrow('工具响应被输出上限')
  })

  it('主代理 HTTP 200 的鉴权错误不执行工具、不重试、不发送 done', async () => {
    fixture.fetch.mockResolvedValue(sseResponse(frame({ error: { type: 'authentication_error', message: 'Fixture credential failure' } })))
    expect((await send()).ok).toBe(false)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(fixture.runTool).not.toHaveBeenCalled()
    expect(fixture.events.some((event) => event.type === 'done')).toBe(false)
  })

  it('主代理的截断工具响应进入重试，只有完整响应才能执行', async () => {
    vi.useFakeTimers()
    const partial = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial-call', function: { name: 'read_file', arguments: '{"path":"fixture.tsx"}' } }] } }] }
    fixture.fetch.mockResolvedValueOnce(sseResponse(frame(partial)))
      .mockResolvedValueOnce(response(['complete-call']))
      .mockResolvedValueOnce(response([]))
    const result = send()
    await vi.advanceTimersByTimeAsync(5000)
    expect((await result).ok).toBe(true)
    expect(fixture.runTool).toHaveBeenCalledTimes(1)
    expect(fixture.runTool.mock.calls[0][0].id).toBe('complete-call')
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'retry', attempt: 1 }))
    expect(fixture.events.some((event) => event.type === 'tool_use' && event.toolUseId === 'partial-call')).toBe(false)
  })

  it('主代理终态完整但工具参数 JSON 截断时不执行任何工具', async () => {
    vi.useFakeTimers()
    const invalid = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'invalid-args', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: 'tool_calls' }] }
    fixture.fetch.mockResolvedValueOnce(sseResponse(frame(invalid) + 'data: [DONE]\n\n')).mockResolvedValueOnce(response([]))
    const result = send()
    await vi.advanceTimersByTimeAsync(5000)
    expect((await result).ok).toBe(true)
    expect(fixture.runTool).not.toHaveBeenCalled()
    expect(fixture.events.some((event) => event.type === 'tool_use')).toBe(false)
  })

  it('Anthropic 已关闭工具块后的服务错误仍然阻止执行', async () => {
    fixture.cfg.llmProfiles[0].provider = 'anthropic'
    const raw = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'should-not-run', name: 'read_file', input: { path: 'fixture.tsx' } } },
      { type: 'content_block_stop', index: 0 },
      { type: 'error', error: { type: 'authentication_error', message: 'Fixture late provider error' } },
    ].map(frame).join('')
    fixture.fetch.mockResolvedValue(sseResponse(raw))
    expect((await send()).ok).toBe(false)
    expect(fixture.runTool).not.toHaveBeenCalled()
    expect(fixture.events.some((event) => event.type === 'tool_use' || event.type === 'done')).toBe(false)
  })
})
