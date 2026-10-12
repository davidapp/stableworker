import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '../src/main/tools'

vi.mock('electron', () => ({ app: { getPath: () => '/fixture-user-data' }, ipcMain: { handle: vi.fn() }, safeStorage: {} }))
import { executeToolCall, runToolUseBlock } from '../src/main/tools'

let project: string
beforeEach(async () => { project = await mkdtemp(join(tmpdir(), 'stableworker-tools-')) })
afterEach(async () => { vi.useRealTimers(); await rm(project, { recursive: true, force: true }) })

describe('工具执行器', () => {
  it('read_file offset 正常返回行号与内容，不留下超时定时器或 abort 监听', async () => {
    await writeFile(join(project, 'fixture.tsx'), Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join('\n'))
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = await executeToolCall('read_file', { path: 'fixture.tsx', offset: 20, limit: 2 }, project, { signal: controller.signal })
    expect(result).toMatchObject({ content: expect.stringContaining('   20| line-20\n   21| line-21'), isError: false })
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('经过门禁的动态 MCP/task 定义实际执行，并收到 sessionId', async () => {
    const execute = vi.fn().mockResolvedValue({ content: 'Dynamic tool completed' })
    const definition: ToolDefinition = { name: 'mcp__fixture__read', description: 'fixture', inputSchema: {}, execute }
    const result = await runToolUseBlock({ type: 'tool_use', id: 'call', name: definition.name, input: { value: 7 }, status: 'running' }, project, { definition, sessionId: 'session' })
    expect(result).toMatchObject({ content: 'Dynamic tool completed', isError: false })
    expect(execute).toHaveBeenCalledWith({ value: 7 }, expect.objectContaining({ projectPath: project, sessionId: 'session' }))
  })

  it('停止后不再启动工具的副作用', async () => {
    const execute = vi.fn()
    const definition: ToolDefinition = { name: 'fixture-write', description: '', inputSchema: {}, execute }
    const controller = new AbortController()
    controller.abort()
    expect((await executeToolCall(definition.name, {}, project, { definition, signal: controller.signal })).isError).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('动态工具仍受超时限制，超时返回错误并清理监听', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const definition: ToolDefinition = { name: 'fixture-wait', description: '', inputSchema: {}, timeoutMs: 1000, execute: () => new Promise(() => {}) }
    const result = executeToolCall(definition.name, {}, project, { definition, signal: controller.signal })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toMatchObject({ content: '工具执行超时（1s）', isError: true })
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
