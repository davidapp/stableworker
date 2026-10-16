import { spawn } from 'node:child_process'
import type { HookConfig } from '../shared/types'
import { tokenize } from './mcp'

/**
 * Hooks 生命周期钩子引擎（对齐 Claude Code 的 command 类型）：
 * 本地命令 + stdin JSON + 退出码/stdout JSON 协议。
 *
 * preToolUse（每个工具执行前，先于权限规则）：
 *   stdin  { sessionId, toolName, toolInput }
 *   exit 0            → 放行（stdout 有 JSON 时可带决策，见下）
 *   exit 2            → 阻止本次工具调用（stderr/stdout JSON 的 reason 喂给模型）
 *   stdout JSON       → { "decision": "approve" } 跳过批准门
 *                       { "updatedInput": {...} } 改写入参（配合 exit 0）
 *                       { "decision": "block", "reason": "..." } 阻止 + 理由
 * postToolUse（工具执行后）：
 *   stdin  { sessionId, toolName, toolInput, toolResult }
 *   stdout JSON { "additionalContext": "..." } → 追加到工具结果后喂给模型
 * stop（每轮对话正常结束前）：
 *   stdin  { sessionId }；输出忽略，仅跑副作用（通知/清理等）
 *
 * 失败策略 fail-open：hook 崩溃/超时/输出非法 → 忽略该 hook，不阻塞工具。
 */

const DEFAULT_HOOK_TIMEOUT_MS = 10_000

export interface HookContext {
  sessionId: string
  toolName: string
  toolInput?: Record<string, unknown>
  toolResult?: string
}

export interface PreToolUseOutcome {
  /** 阻止本次工具调用（reason 喂给模型） */
  blocked?: boolean
  reason?: string
  /** 跳过批准门（即使工具标记 requiresApproval） */
  autoApprove?: boolean
  /** 改写后的工具入参 */
  updatedInput?: Record<string, unknown>
}

/** 工具名匹配器：'' = 全部；精确名；或前缀通配（Bash* ） */
export function hookMatches(hook: HookConfig, toolName: string): boolean {
  if (hook.event === 'stop') return true
  const m = hook.matcher.trim()
  if (!m || m === '*') return true
  if (m.endsWith('*')) return toolName.startsWith(m.slice(0, -1))
  return toolName === m
}

interface HookRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runHookCommand(command: string, input: unknown, timeoutMs: number): Promise<HookRunResult> {
  return new Promise((resolve) => {
    const parts = tokenize(command)
    if (parts.length === 0) {
      resolve({ exitCode: null, stdout: '', stderr: 'hook 命令为空', timedOut: false })
      return
    }
    const child = spawn(parts[0], parts.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (!child.killed) child.kill()
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: stderr + err.message, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
    try {
      child.stdin?.write(JSON.stringify(input))
      child.stdin?.end()
    } catch {
      // stdin 写失败不致命：命令可能提前退出
    }
  })
}

/** 从 stdout 提取第一个 JSON 对象（兼容前面混入的日志行） */
function parseHookJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      const v = JSON.parse(s) as unknown
      if (v && typeof v === 'object') return v as Record<string, unknown>
    } catch {
      // 不是 JSON 的行忽略
    }
  }
  return null
}

function activeHooks(hooks: HookConfig[] | undefined, event: HookConfig['event'], toolName?: string): HookConfig[] {
  return (hooks ?? []).filter(
    (h) => !h.disabled && h.event === event && (toolName === undefined || hookMatches(h, toolName)),
  )
}

/** preToolUse：依次执行匹配的钩子，聚合决策（任一 block 即阻止；approve/updatedInput 取最后写入者） */
export async function runPreToolUseHooks(
  hooks: HookConfig[] | undefined,
  ctx: HookContext,
): Promise<PreToolUseOutcome> {
  const outcome: PreToolUseOutcome = {}
  for (const hook of activeHooks(hooks, 'preToolUse', ctx.toolName)) {
    const r = await runHookCommand(
      hook.command,
      { sessionId: ctx.sessionId, toolName: ctx.toolName, toolInput: ctx.toolInput },
      hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    )
    if (r.timedOut || r.exitCode === null) {
      // fail-open，但要有迹可查：钩子崩溃/超时打日志
      console.error(`[hooks] preToolUse 钩子被跳过（${r.timedOut ? '超时' : `exit=${r.exitCode}`}）: ${hook.command}`, r.stderr.trim() || '')
      continue
    }
    if (r.exitCode === 2) {
      const json = parseHookJson(r.stdout)
      outcome.blocked = true
      outcome.reason =
        (json?.reason as string | undefined) ?? r.stderr.trim() ?? '被 PreToolUse 钩子阻止'
      continue
    }
    const json = parseHookJson(r.stdout)
    if (!json) continue
    if (json.decision === 'block') {
      outcome.blocked = true
      outcome.reason = (json.reason as string | undefined) ?? '被 PreToolUse 钩子阻止'
    } else if (json.decision === 'approve') {
      outcome.autoApprove = true
    }
    if (json.updatedInput && typeof json.updatedInput === 'object') {
      outcome.updatedInput = json.updatedInput as Record<string, unknown>
    }
  }
  return outcome
}

/** postToolUse：聚合所有钩子的 additionalContext（换行连接），无则 null */
export async function runPostToolUseHooks(
  hooks: HookConfig[] | undefined,
  ctx: HookContext,
): Promise<string | null> {
  const parts: string[] = []
  for (const hook of activeHooks(hooks, 'postToolUse', ctx.toolName)) {
    const r = await runHookCommand(
      hook.command,
      {
        sessionId: ctx.sessionId,
        toolName: ctx.toolName,
        toolInput: ctx.toolInput,
        toolResult: (ctx.toolResult ?? '').slice(0, 20_000),
      },
      hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    )
    if (r.timedOut || r.exitCode === null) continue
    const json = parseHookJson(r.stdout)
    const ctxText = json?.additionalContext
    if (typeof ctxText === 'string' && ctxText.trim()) parts.push(ctxText.trim())
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/** stop：跑完全部 stop 钩子（副作用型，输出忽略；失败不影响对话） */
export async function runStopHooks(hooks: HookConfig[] | undefined, sessionId: string): Promise<void> {
  for (const hook of activeHooks(hooks, 'stop')) {
    await runHookCommand(hook.command, { sessionId }, hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS).catch(() => {})
  }
}
