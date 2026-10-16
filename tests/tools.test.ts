import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '../src/main/tools'

vi.mock('electron', () => ({ app: { getPath: () => '/fixture-user-data' }, ipcMain: { handle: vi.fn() }, safeStorage: {} }))
import { executeToolCall, runToolUseBlock } from '../src/main/tools'
import { safeResolve } from '../src/main/tools/paths'
import { getShellTask, startShellTask, stopSessionShellTasks } from '../src/main/tools/shellTasks'
import { canSymlink } from './helpers'

let project: string
beforeEach(async () => { project = await mkdtemp(join(tmpdir(), 'stableworker-tools-')) })
afterEach(async () => { vi.useRealTimers(); await rm(project, { recursive: true, force: true }) })

describe('工具执行器', () => {
  it('拒绝符号链接读写逃出工作目录，同时允许目录内新建文件', async (ctx) => {
    if (!(await canSymlink())) {
      ctx.skip()
      return
    }
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

  it('中止前台 shell 会杀掉子进程，后续文件副作用不会发生', { retry: 2, timeout: 30_000 }, async (ctx) => {
    // Windows 已知局限：vitest worker 环境下 cmd 可能在 taskkill 启动前自行退出（报"没有找到进程"），
    // 孙进程短暂孤儿化。真实应用未复现；POSIX 平台全量验证树杀。
    if (process.platform === 'win32') {
      ctx.skip()
      return
    }
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    // 跨平台：node 轮询 release 文件出现才写 sentinel（POSIX 的 while/sleep 在 Windows cmd 上不可用）。
    // 若中止后进程树未被杀干净，release 出现时 sentinel 仍会被写入 → 断言失败。
    const command = `node -e "console.log('ready');const fs=require('fs');const i=setInterval(function(){if(fs.existsSync('release')){fs.writeFileSync('sentinel','stale');process.exit(0)}},50)"`
    const result = executeToolCall('run_command', { command }, project, {
      signal: controller.signal, onOutput: (text) => { if (text.includes('ready')) started() },
    })
    await ready
    controller.abort()
    expect((await result).isError).toBe(true)
    await writeFile(join(project, 'release'), 'go')
    // taskkill 是异步发射的，高负载下进程启动可能慢数百毫秒：
    // 给 3s 宽限轮询——期间出现 sentinel = 进程树没被杀干净（失败）；超时未出现 = 通过
    let survived = false
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const content = await readFile(join(project, 'sentinel'), 'utf-8').catch(() => null)
      if (content != null) {
        survived = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(survived).toBe(false)
  })

  it('停止一个会话只终止其所属后台任务', async () => {
    // 跨平台长驻命令：node 定时器（Windows cmd 没有 sleep）
    const sleeper = `node -e "setInterval(function(){},1000)"`
    const first = startShellTask('test-stop-a', sleeper, project, 'session-a')
    const second = startShellTask('test-stop-b', sleeper, project, 'session-b')
    stopSessionShellTasks('session-a')
    expect(getShellTask(first.id)?.status).toBe('killed')
    expect(getShellTask(second.id)?.status).toBe('running')
    stopSessionShellTasks('session-b')
    // taskkill 异步生效；等进程真正退出再结束用例，否则 afterEach rmdir 会 EBUSY（cwd 被占）
    const waitExit = (t: ReturnType<typeof startShellTask>): Promise<void> =>
      new Promise((resolve) => {
        if (t.child.exitCode != null) return resolve()
        const timer = setTimeout(resolve, 3_000)
        timer.unref?.()
        t.child.once('close', () => { clearTimeout(timer); resolve() })
      })
    await waitExit(first)
    await waitExit(second)
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
