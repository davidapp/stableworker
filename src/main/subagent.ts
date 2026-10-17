import type { ChatHistoryMessage, MessageBlock, SubagentTypeConfig, ToolUseBlock } from '../shared/types'
import type { ToolContext, ToolDefinition } from './tools/index'

/**
 * 子代理（对齐 Claude Code 的 Task 工具）：
 * 在独立上下文里跑一个完整的"请求 → 工具 → 再请求"循环，只把最终报告
 * 作为 tool 结果返回主对话——大范围调研不会塞满主上下文。
 *
 * 两种类型：
 * - general-purpose：继承主循环工具池（去掉 task / ask_user_question）
 * - Explore：只读（从工具池再过滤掉所有需要批准的工具）
 *
 * 结构说明：本模块只含循环逻辑，API 调用（callRound）与带门禁的工具执行
 * （executeTool：批准卡 / 权限规则 / 检查点）由 llm.ts 注入，因此循环可以
 * 用假实现做纯逻辑测试；llm.ts ↔ 本模块的循环引用只在运行期函数调用，
 * 模块求值期互不访问。
 */

export type SubagentType = 'general-purpose' | 'Explore'

export interface SubagentRound {
  blocks: MessageBlock[]
}

export interface RunSubagentArgs {
  prompt: string
  subagentType: SubagentType
  /** 主循环当前工具池（已过工具开关与规划模式过滤，不含 task 自身） */
  baseTools: ToolDefinition[]
  /** 基础系统提示词（随每轮请求发送；自定义类型会追加角色设定） */
  systemPrompt: string
  /** 预解析好的类型（自定义代理类型用）；不传则按 subagentType 解析内置类型 */
  resolved?: ResolvedSubagentType
  maxRounds?: number
  signal: AbortSignal
  /** 进度一行；主进程把它 emit 成 tool_output 挂到 task 工具卡片的实时输出区 */
  onProgress: (line: string) => void
  /** 一轮 API 调用：返回本轮助手 blocks（与主循环同构，工具结果挂在 tool_use 块上） */
  callRound: (
    messages: ChatHistoryMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    systemPrompt: string,
  ) => Promise<SubagentRound>
  /** 带门禁执行一个工具调用（会原地写 tu.status / tu.result / tu.durationMs） */
  executeTool: (tu: ToolUseBlock) => Promise<void>
}

function textOf(blocks: MessageBlock[]): string {
  return blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim()
}

/** 子代理工具池：两种类型共同的裁剪（不允许递归子代理、不能向用户提问） */
function pickTools(subagentType: SubagentType, baseTools: ToolDefinition[]): ToolDefinition[] {
  const excluded = new Set(['task', 'ask_user_question'])
  const pool = baseTools.filter((t) => !excluded.has(t.name))
  if (subagentType === 'Explore') return pool.filter((t) => !t.requiresApproval)
  return pool
}

/** 解析后的子代理类型：工具池 + 进度显示名 + 追加系统提示 */
export interface ResolvedSubagentType {
  pool: ToolDefinition[]
  label: string
  promptAppend?: string
}

/**
 * 按名称解析子代理类型：内置 general-purpose / Explore，或用户在设置里
 * 定义的自定义类型（工具范围 + 角色设定）。未知名称回退为 general-purpose。
 */
export function resolveSubagentType(
  type: string,
  baseTools: ToolDefinition[],
  customTypes: SubagentTypeConfig[],
): ResolvedSubagentType {
  const custom = customTypes.find((c) => c.name === type)
  if (custom) {
    return {
      pool: pickTools(custom.tools === 'read-only' ? 'Explore' : 'general-purpose', baseTools),
      label: `自定义 · ${custom.name}`,
      promptAppend: custom.prompt.trim() || undefined,
    }
  }
  const t: SubagentType = type === 'Explore' ? 'Explore' : 'general-purpose'
  return { pool: pickTools(t, baseTools), label: t === 'Explore' ? '只读研究型' : '通用型' }
}

/** 只读工具（kind === 'read' 且无需批准）才允许与其他调用并行执行 */
export function isParallelSafe(tu: ToolUseBlock, tools: ToolDefinition[]): boolean {
  const def = tools.find((d) => d.name === tu.name)
  return Boolean(def && !def.requiresApproval && def.kind === 'read')
}

/** 工具调用的一行摘要（进度用）：抓最有辨识度的参数截断 */
function summarizeInput(tu: ToolUseBlock): string {
  const raw = (tu.input.path ?? tu.input.command ?? tu.input.pattern ?? tu.input.query ?? tu.input.url ?? '') as string
  const s = (typeof raw === 'string' ? raw : JSON.stringify(tu.input)).replace(/\s+/g, ' ').trim()
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}

function tailLine(text: string | undefined): string {
  if (!text) return ''
  const s = text.replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > 120 ? ' ' + s.slice(0, 120) + '…' : ' ' + s
}

export async function runSubagent(args: RunSubagentArgs): Promise<{ content: string; isError: boolean }> {
  const { prompt, baseTools, systemPrompt, signal, onProgress, callRound, executeTool } = args
  const maxRounds = args.maxRounds ?? 12
  const resolved = args.resolved ?? resolveSubagentType(args.subagentType, baseTools, [])
  const tools = resolved.pool
  const effectiveSystem = resolved.promptAppend ? `${systemPrompt}\n\n角色设定：${resolved.promptAppend}` : systemPrompt
  const messages: ChatHistoryMessage[] = [{ role: 'user', blocks: [{ type: 'text', text: prompt }] }]
  onProgress(
    `🤖 子代理启动 · ${resolved.label} · ${tools.length} 个工具 · 最多 ${maxRounds} 轮`,
  )

  const finalTextOf = (blocks: MessageBlock[]): string => textOf(blocks) || '（子代理没有返回文本内容）'

  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (signal.aborted) return { content: '任务被用户停止', isError: true }
      const { blocks } = await callRound(messages, tools, signal, effectiveSystem)
      messages.push({ role: 'assistant', blocks })

      const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
      if (toolUses.length === 0) {
        onProgress(`✅ 子代理完成（${round - 1} 次工具调用）`)
        return { content: finalTextOf(blocks), isError: false }
      }
      onProgress(`── 第 ${round} 轮：${toolUses.length} 个工具调用`)
      // 只读调用并行执行（对齐 Claude Code 的并行工具）；含写/需批准的轮次保持串行
      if (toolUses.length > 1 && toolUses.every((tu) => isParallelSafe(tu, tools))) {
        await Promise.all(
          toolUses.map(async (tu) => {
            onProgress(`🛠 ${tu.name}（${summarizeInput(tu)}）`)
            await executeTool(tu)
            onProgress(`${tu.status === 'error' ? '  ✗' : '  ✓'} ${tu.name}${tailLine(tu.result)}`)
          }),
        )
      } else {
        for (const tu of toolUses) {
          if (signal.aborted) break
          onProgress(`🛠 ${tu.name}（${summarizeInput(tu)}）`)
          await executeTool(tu)
          onProgress(`${tu.status === 'error' ? '  ✗' : '  ✓'} ${tu.name}${tailLine(tu.result)}`)
        }
      }
    }

    // 轮次用尽：不带工具再收尾一次，强制汇总成最终报告
    onProgress('⚠ 已达子代理最大轮次，做一次收尾汇总')
    messages.push({
      role: 'user',
      blocks: [{ type: 'text', text: '（系统提示：已达最大工具轮次。请基于以上全部发现立即输出最终报告，不要再调用工具。）' }],
    })
    const final = await callRound(messages, [], signal, effectiveSystem)
    onProgress('✅ 子代理完成（轮次上限收尾）')
    return { content: finalTextOf(final.blocks), isError: false }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    onProgress(`✗ 子代理失败：${msg}`)
    return { content: `子代理执行失败：${msg}`, isError: true }
  }
}

// ---------- task 工具定义 ----------

export const TASK_TOOL_NAME = 'task'

/** 并行子代理上限：一轮里同时跑的 task 数（保护 API 速率与 token 消耗） */
export const MAX_PARALLEL_TASKS = 4

/** 按 cap 分批（并行子代理用） */
export function parallelBatches<T>(items: T[], cap = MAX_PARALLEL_TASKS): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += cap) out.push(items.slice(i, i + cap))
  return out
}

export interface TaskToolDeps {
  baseTools: ToolDefinition[]
  /** 基础系统提示词（llm.ts 构建；自定义类型的角色设定会追加在它后面） */
  systemPrompt: string
  /** 用户自定义的子代理类型（设置页维护） */
  customTypes: SubagentTypeConfig[]
  signal: AbortSignal
  callRound: RunSubagentArgs['callRound']
  executeTool: RunSubagentArgs['executeTool']
}

export function createTaskTool(deps: TaskToolDeps): ToolDefinition {
  const customNames = deps.customTypes.map((c) => c.name)
  const customHint = deps.customTypes.length
    ? ' 可选的自定义类型：' + deps.customTypes.map((c) => `${c.name}（${c.description}）`).join('；') + '。'
    : ''
  return {
    name: TASK_TOOL_NAME,
    description:
      '把一个独立任务分派给子代理（subagent）执行。子代理拥有独立上下文与工具，自主完成多轮"读代码/搜索/执行"后' +
      '只把最终报告返回。适用：大范围代码调研（读很多文件但只需一段结论）、独立的小任务、需要隔离中间过程的探索。' +
      'prompt 必须自包含（子代理看不到主对话历史）；subagent_type 选 Explore（只读研究，更快更安全）或 general-purpose（可用全部工具）。' +
      '相互独立的多个任务可以在同一轮里发出多个 task 调用并行执行（最多同时 4 个）。' + customHint,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '任务描述，必须自包含：目标、背景、期望的报告内容' },
        subagent_type: {
          type: 'string',
          enum: ['general-purpose', 'Explore', ...customNames],
          description: '子代理类型，默认 general-purpose；纯研究任务建议 Explore',
        },
      },
      required: ['prompt'],
    },
    // 子代理可能跑很久：不设工具级超时（执行器对非有限值跳过超时竞速）
    timeoutMs: Number.POSITIVE_INFINITY,
    requiresApproval: false,
    async execute(input: Record<string, unknown>, ctx: ToolContext) {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      if (!prompt) return { content: '缺少 prompt 参数：请描述要分派给子代理的任务', isError: true }
      const r = await runSubagent({
        prompt,
        subagentType: input.subagent_type === 'Explore' ? 'Explore' : 'general-purpose',
        resolved: resolveSubagentType(String(input.subagent_type ?? ''), deps.baseTools, deps.customTypes),
        baseTools: deps.baseTools,
        systemPrompt: deps.systemPrompt,
        signal: deps.signal,
        // 进度走 ctx.onOutput（已由执行器绑定到本工具调用卡片"实时输出"区）
        onProgress: (line) => ctx.onOutput?.(line + '\n'),
        callRound: deps.callRound,
        executeTool: deps.executeTool,
      })
      return { content: r.content, isError: r.isError }
    },
  }
}

/** 子代理的系统提示词（拼在项目上下文前） */
export function buildSubagentSystemPrompt(subagentType: SubagentType, projectContext: string): string {
  const lines = [
    '你是 StableWorker 的子代理，在独立上下文中完成主代理分派的一项任务。',
    '主对话只能看到你的最终报告——中间过程（读文件、搜索、运行命令）由你自主完成，不会被打断。',
    '最终报告必须完整、自包含：结论 + 关键证据（文件路径:行号、命令输出摘录）+ 未能解决的问题。',
    subagentType === 'Explore'
      ? '你只有只读工具：只做研究，绝不修改文件、不执行有副作用的命令。'
      : '你可以使用全部可用工具完成任务。',
    '没有向用户提问的渠道，遇到不确定的点在报告里说明假设即可。',
  ]
  return lines.join('\n') + (projectContext ? `\n\n${projectContext}` : '')
}
