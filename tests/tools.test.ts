import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '../src/main/tools'

vi.mock('electron', () => ({ app: { getPath: () => '/fixture-user-data' }, ipcMain: { handle: vi.fn() }, safeStorage: {} }))
import { executeToolCall, runToolUseBlock } from '../src/main/tools'
import { safeResolve } from '../src/main/tools/paths'
import { getShellTask, startShellTask, stopSessionShellTasks } from '../src/main/tools/shellTasks'

let project: string
beforeEach(async () => { project = await mkdtemp(join(tmpdir(), 'stableworker-tools-')) })
afterEach(async () => { vi.useRealTimers(); await rm(project, { recursive: true, force: true }) })

describe('工具执行器', () => {
  it('拒绝符号链接读写逃出工作目录，同时允许目录内新建文件', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'sw-outside-'))
    try {
      await writeFile(join(outside, 'secret'), 'outside')
      await symlink(outside, join(project, 'escape'), 'dir')
      await symlink(join(outside, 'missing'), join(project, 'dangling'))
      expect(() => safeResolve(project, 'escape/secret')).toThrow('符号链接')
      expect(() => safeResolve(project, 'escape/new/file')).toThrow('符号链接')
      expect(() => safeResolve(project, 'dangling')).toThrow('符号链接')
      expect(safeResolve(project, 'new/nested/file')).toBe(join(project, 'new/nested/file'))
      await mkdir(join(project, 'real'))
      await symlink(join(project, 'real'), join(project, 'inside'), 'dir')
      expect(safeResolve(project, 'inside/new')).toBe(join(project, 'inside/new'))
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  it('中止前台 shell 会杀掉子进程，后续文件副作用不会发生', async () => {
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    // A gate keeps the side effect pending regardless of CI scheduling or CPU load.
    const result = executeToolCall('run_command', { command: 'echo ready; while [ ! -f release ]; do sleep 0.05; done; echo stale > sentinel' }, project, {
      signal: controller.signal, onOutput: (text) => { if (text.includes('ready')) started() },
    })
    await ready
    controller.abort()
    expect((await result).isError).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await writeFile(join(project, 'release'), 'go')
    await new Promise((resolve) => setTimeout(resolve, 150))
    await expect(readFile(join(project, 'sentinel'))).rejects.toThrow()
  })

  it('停止一个会话只终止其所属后台任务', async () => {
    const first = startShellTask('test-stop-a', 'sleep 5', project, 'session-a')
    const second = startShellTask('test-stop-b', 'sleep 5', project, 'session-b')
    stopSessionShellTasks('session-a')
    expect(getShellTask(first.id)?.status).toBe('killed')
    expect(getShellTask(second.id)?.status).toBe('running')
    stopSessionShellTasks('session-b')
  })

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
    expect(execute.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
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
    let underlyingSignal: AbortSignal | undefined
    const definition: ToolDefinition = { name: 'fixture-wait', description: '', inputSchema: {}, timeoutMs: 1000, execute: (_input, ctx) => { underlyingSignal = ctx.signal; return new Promise(() => {}) } }
    const result = executeToolCall(definition.name, {}, project, { definition, signal: controller.signal })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toMatchObject({ content: '工具执行超时（1s）', isError: true })
    expect(underlyingSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
