import { describe, expect, it } from 'vitest'
import type { HookConfig } from '../src/shared/types'
import { hookMatches, runPostToolUseHooks, runPreToolUseHooks } from '../src/main/hooks'

/** 跨平台 hook 命令：spawn 不经 shell，参数用双引号包（tokenize 会剥掉） */
const node = (code: string): string => `node -e "${code.replaceAll('"', '\\"')}"`

function hook(partial: Partial<HookConfig> & { command: string }): HookConfig {
  return {
    id: partial.id ?? 'h',
    event: partial.event ?? 'preToolUse',
    matcher: partial.matcher ?? '',
    command: partial.command,
    timeoutMs: partial.timeoutMs,
    disabled: partial.disabled,
  }
}

const ctx = { sessionId: 's1', toolName: 'run_command', toolInput: { command: 'npm test' } }

/** spawn + node 启动在并发套跑下可能到数秒：给足超时避免资源竞争误报 */
const SLOW = 20_000

describe('hookMatches 匹配器', () => {
  it('空/星号 = 全部，精确名，前缀通配', () => {
    expect(hookMatches(hook({ command: 'x' }), 'run_command')).toBe(true)
    expect(hookMatches(hook({ command: 'x', matcher: '*' }), 'anything')).toBe(true)
    expect(hookMatches(hook({ command: 'x', matcher: 'run_command' }), 'run_command')).toBe(true)
    expect(hookMatches(hook({ command: 'x', matcher: 'run_command' }), 'read_file')).toBe(false)
    expect(hookMatches(hook({ command: 'x', matcher: 'read_*' }), 'read_file')).toBe(true)
    expect(hookMatches(hook({ command: 'x', matcher: 'read_*' }), 'grep')).toBe(false)
  })
})

describe('preToolUse 钩子协议', () => {
  it('exit 0 无输出 = 放行', async () => {
    const r = await runPreToolUseHooks([hook({ command: node('process.exit(0)') })], ctx)
    expect(r).toEqual({})
  }, SLOW)

  it('exit 2 = 阻止，stderr 作为理由', async () => {
    const r = await runPreToolUseHooks([hook({ command: node('console.error("不许跑测试");process.exit(2)') })], ctx)
    expect(r.blocked).toBe(true)
    expect(r.reason).toContain('不许跑测试')
  }, SLOW)

  it('stdout JSON block 决策 + 理由', async () => {
    const cmd = node(`console.log(JSON.stringify({decision:'block',reason:'命令在黑名单'}))`)
    const r = await runPreToolUseHooks([hook({ command: cmd })], ctx)
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('命令在黑名单')
  }, SLOW)

  it('approve 决策 + updatedInput 改写入参', async () => {
    const cmd = node(`console.log(JSON.stringify({decision:'approve',updatedInput:{command:'npm run test:safe'}}))`)
    const r = await runPreToolUseHooks([hook({ command: cmd })], ctx)
    expect(r.autoApprove).toBe(true)
    expect(r.updatedInput).toEqual({ command: 'npm run test:safe' })
  }, SLOW)

  it('stdin 收到 JSON 上下文（工具名与入参）', async () => {
    const { join } = await import('node:path')
    const os = await import('node:os')
    const { readFile, rm } = await import('node:fs/promises')
    const file = join(os.tmpdir(), `sw-hook-stdin-${Date.now()}.json`)
    const cmd = node(
      `const fs=require('fs');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(file)},d))`,
    )
    await runPreToolUseHooks([hook({ command: cmd })], ctx)
    const got = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(got).toMatchObject({ sessionId: 's1', toolName: 'run_command', toolInput: { command: 'npm test' } })
    await rm(file, { force: true })
  }, SLOW)

  it('matcher 不匹配的钩子不执行（不产生阻止）', async () => {
    const blocker = node('process.exit(2)')
    const r = await runPreToolUseHooks([hook({ command: blocker, matcher: 'read_file' })], ctx)
    expect(r.blocked).toBeUndefined()
  }, SLOW)

  it('崩溃/超时 fail-open：不阻塞工具', async () => {
    const crash = node('process.exit(1)')
    const timeout = node('setInterval(()=>{},1000)')
    const r = await runPreToolUseHooks(
      [hook({ command: crash }), hook({ command: timeout, timeoutMs: 300 })],
      ctx,
    )
    expect(r.blocked).toBeUndefined()
  }, SLOW)

  it('禁用的钩子不执行', async () => {
    const r = await runPreToolUseHooks([hook({ command: node('process.exit(2)'), disabled: true })], ctx)
    expect(r.blocked).toBeUndefined()
  }, SLOW)
})

describe('postToolUse 钩子协议', () => {
  it('additionalContext 聚合（多个钩子换行连接）', async () => {
    const a = node(`console.log(JSON.stringify({additionalContext:'记得跑 lint'}))`)
    const b = node(`console.log(JSON.stringify({additionalContext:'已自动格式化'}))`)
    const r = await runPostToolUseHooks([hook({ command: a, event: 'postToolUse' }), hook({ command: b, event: 'postToolUse' })], {
      ...ctx,
      toolResult: '命令输出……',
    })
    expect(r).toBe('记得跑 lint\n已自动格式化')
  })

  it('无输出 = null', async () => {
    const r = await runPostToolUseHooks([hook({ command: node('process.exit(0)'), event: 'postToolUse' })], {
      ...ctx,
      toolResult: 'x',
    })
    expect(r).toBeNull()
  }, SLOW)
})
