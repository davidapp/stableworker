import { BrowserWindow, ipcMain } from 'electron'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import type { Dispatcher } from 'undici'
import { loadConfig, decryptApiKey, resolveEffectiveSettings, getApprovalMode } from './config'
import { resolveModelContext } from './modelContexts'
import {
  beginExchange,
  recordStatus,
  recordSSELine,
  recordUsageEvent,
  recordAssembledText,
  recordReasoningText,
  recordToolCalls,
  endExchange,
  maskHeaders,
} from './debug'
import { isPeakTime } from './pricing'
import { requestApproval, resolveSessionApprovals, requestUserInput, resolveSessionUserInputs } from './approvals'
import { snapshotFilesBeforeChange, sessionCheckpointsRoot } from './fileHistory'
import { getToolDefinitions, runToolUseBlock, type ToolDefinition } from './tools'
import { stopSessionShellTasks } from './tools/shellTasks'
import { trimHistory } from './contextTrim'
import {
  mergeSummaryIntoFirstUser,
  summarizeWithModel,
  worthSummarizing,
  getCachedCompact,
  setCachedCompact,
} from './compact'
import { appendSummaryLine, loadSessionAny } from './sessions'
import { officeSystemPrompt, toolsForTaskMode } from './officeMode'
import { evaluateRules, suggestRule } from './permissions'
import { loadAgentsMd } from './agentsMd'
import { ensureMcpConnections, getMcpToolDefs, getResourceTools } from './mcp'
import { createTaskTool, buildSubagentSystemPrompt, isParallelSafe, parallelBatches, TASK_TOOL_NAME } from './subagent'
import { runPreToolUseHooks, runPostToolUseHooks, runStopHooks } from './hooks'
import { microCompactHistory } from './microCompact'
import { withRetry, HttpError, RETRYABLE_STATUS, isAbortError } from './withRetry'
import { estimateTokens } from '../shared/tokens'
import { recordContextBreakdown } from './debug'
import type {
  ApprovalMode,
  ChatEvent,
  ChatRequest,
  ChatHistoryMessage,
  HookConfig,
  LLMConfig,
  LLMTestPayload,
  MessageBlock,
  PermissionRules,
  TodoItem,
  ToolUseBlock,
} from '../shared/types'

/**
 * LLM 调用层 + 代理循环（Agent Loop）：
 * 主进程流式请求模型 → 模型请求工具 → 主进程执行（tools 模块）→ 结果回传 → 模型继续，
 * 直到模型给出纯文本回复或达到轮次上限。每一轮 API 调用单独记录到调试面板。
 *
 * 协议支持：
 * - openai-compatible：/chat/completions + tools（function calling），工具结果用 role:'tool'
 * - anthropic：/v1/messages + tools，工具结果作为 user 消息里的 tool_result 块
 *
 * 流式工具调用解析：OpenAI 的 delta.tool_calls 按 index 分片累积 arguments；
 * Anthropic 用 content_block_start / input_json_delta / content_block_stop 组装。
 * 两种协议的线上格式都可以在"API 调试"面板里逐行观察。
 */

const SYSTEM_PROMPT_BASE = [
  '你是 StableWorker，一个运行在用户本地电脑上的 AI 编程助手。回答简洁准确，使用与用户相同的语言。',
  // 告知操作系统与 shell：跨平台下模型需要据此生成正确的命令与路径语法
  `运行环境：${process.platform === 'win32' ? 'Windows，shell 为 cmd.exe' : process.platform === 'darwin' ? 'macOS，shell 为 zsh/bash' : 'Linux，shell 为 bash'}；生成命令时使用该平台的语法与路径分隔符。`,
  // 工具使用纪律：防止模型"口头交差"——声称完成却没调用工具落盘
  '凡创建或修改文件，必须调用 write_file / edit_file 工具执行；只在回复里贴出代码或声称"已写好"而未调用工具，视为任务未完成。',
  '汇报结果前先核对：只有看到工具返回成功结果，才可以说文件已写入。',
].join('\n')
const MAX_TOKENS = 8192
const MAX_TOOL_ROUNDS = 50

/** 任务清单缓存：会话 id → 当前任务清单（todo_write 工具维护，进程内） */
const sessionTodos = new Map<string, TodoItem[]>()

const aborters = new Map<string, AbortController>()
const proxyAgents = new Map<string, ProxyAgent>()

type HistoryMessage = ChatHistoryMessage

function emit(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // 跳过已销毁的窗口：调试悬浮窗关闭的瞬间 send 会抛
    // "Object has been destroyed"，导致 done 事件发不出去、UI 永远停在生成中
    if (!win.isDestroyed()) win.webContents.send('chat:event', event)
  }
}

function defaultBaseURL(provider: LLMConfig['provider']): string {
  return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'
}

function joinURL(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

/** 根据配置构建请求的 dispatcher：配置了代理返回 ProxyAgent，留空 undefined（直连） */
export function getProxyDispatcher(proxyURL: string): Dispatcher | undefined {
  const trimmed = proxyURL.trim()
  if (!trimmed) return undefined
  let protocol: string
  try {
    protocol = new URL(trimmed).protocol
  } catch {
    throw new Error(`代理地址无效：${trimmed}`)
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`不支持的代理协议 ${protocol}（当前支持 http/https 代理）`)
  }
  let agent = proxyAgents.get(trimmed)
  if (!agent) {
    agent = new ProxyAgent(trimmed)
    proxyAgents.set(trimmed, agent)
  }
  return agent
}

// ---------- 系统提示词 ----------

function buildSystemPrompt(projectPath: string | null, agentsMd: string): string {
  if (!projectPath) return SYSTEM_PROMPT_BASE
  const agentsBlock = agentsMd ? `\n\n以下是分层记忆（全局 → 项目约定，近处优先），请严格遵守：\n${agentsMd}` : ''
  return `${SYSTEM_PROMPT_BASE}\n当前项目目录：${projectPath}\n你可以调用工具查看项目文件：了解目录结构用 list_files，查看文件内容用 read_file。涉及项目内容的问题先查再答，不要凭空猜测。${agentsBlock}\n你还有 memory 工具：跨会话的长期记忆目录（按项目隔离）。开始新任务前可先读索引；用户表达持久偏好、做出重要决定、踩坑解决后，主动用 memory 记录。`
}

// ---------- 消息块 → 各协议的消息序列 ----------

interface ToolCallDraft {
  id: string
  name: string
  argsJson: string
}

interface ReasoningPart {
  text: string
  signature?: string
}

type ApiTurn =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; reasoning: ReasoningPart[]; text: string; toolCalls: ToolCallDraft[] }
  | { kind: 'tool_results'; results: { toolUseId: string; content: string; isError: boolean }[] }

function textOfBlocks(blocks: MessageBlock[]): string {
  return blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

function parseToolInput(raw: string, name: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('工具参数必须是 JSON 对象')
    return value as Record<string, unknown>
  } catch {
    throw new LLMStreamError(`模型返回的 ${name || '工具'} 参数不完整或不是有效 JSON 对象，工具未执行`, true)
  }
}

/**
 * 把 UI 侧的消息历史转换成协议无关的 API 回合序列。
 * 关键点：一个助手消息里的 blocks 是 [文本, 工具调用(带结果), 文本, …]，
 * 每个"带结果的工具调用"之后都要切一刀——API 上工具结果必须紧跟在
 * 发起调用的那条助手消息之后（Anthropic 是 user/tool_result，OpenAI 是 role:'tool'）。
 */
function toApiTurns(history: HistoryMessage[]): ApiTurn[] {
  const turns: ApiTurn[] = []
  for (const msg of history) {
    if (msg.role === 'user') {
      turns.push({ kind: 'user', text: textOfBlocks(msg.blocks) })
      continue
    }
    // 助手消息整体映射为一个 API 回合：reasoning + 文本 + 全部工具调用在同一条
    // 助手消息里，所有结果合并为紧随其后的 tool_results 回合。
    // 注意不能按单个工具调用切分：DeepSeek thinking 模式要求每条带 tool_calls
    // 的助手消息都携带 reasoning_content，拆开会让后续调用丢失思考内容导致 400。
    const texts: string[] = []
    const reasoning: ReasoningPart[] = []
    const calls: ToolCallDraft[] = []
    const results: { toolUseId: string; content: string; isError: boolean }[] = []
    for (const b of msg.blocks) {
      if (b.type === 'text') {
        texts.push(b.text)
      } else if (b.type === 'reasoning') {
        reasoning.push({ text: b.text, signature: b.signature })
      } else if (b.status !== 'done' && b.status !== 'error') {
        continue // 中断/未批准留下的无结果调用不进历史
      } else {
        calls.push({ id: b.id, name: b.name, argsJson: JSON.stringify(b.input) })
        results.push({ toolUseId: b.id, content: b.result ?? '', isError: b.status === 'error' })
      }
    }
    if (calls.length || texts.length || reasoning.length) {
      turns.push({ kind: 'assistant', reasoning, text: texts.join('\n\n'), toolCalls: calls })
    }
    if (results.length) {
      turns.push({ kind: 'tool_results', results })
    }
  }
  // 删除消息后可能出现相邻的同角色回合（如 user 接 user）：合并以维持
  // "user/assistant 严格交替"的协议要求
  const merged: ApiTurn[] = []
  for (const t of turns) {
    const prev = merged[merged.length - 1]
    if (t.kind === 'user' && prev?.kind === 'user') {
      prev.text = prev.text ? `${prev.text}\n\n${t.text}` : t.text
      continue
    }
    if (t.kind === 'assistant' && prev?.kind === 'assistant' && prev.toolCalls.length === 0 && t.toolCalls.length === 0) {
      prev.text = [prev.text, t.text].filter(Boolean).join('\n\n')
      prev.reasoning = [...prev.reasoning, ...t.reasoning]
      continue
    }
    merged.push(t)
  }
  // 首回合必须是 user（OpenAI/Anthropic 惯例）；被裁后以助手开头的情况补空用户回合
  if (merged[0]?.kind === 'assistant') {
    merged.unshift({ kind: 'user', text: '（继续）' })
  }
  return merged
}

export function buildRequest(
  llm: LLMConfig,
  apiKey: string,
  turns: ApiTurn[],
  tools: ToolDefinition[],
  stream: boolean,
  system: string,
): { url: string; headers: Record<string, string>; body: string } {
  const baseURL = llm.baseURL.trim() || defaultBaseURL(llm.provider)

  if (llm.provider === 'anthropic') {
    const messages: Record<string, unknown>[] = []
    for (const t of turns) {
      if (t.kind === 'user') {
        if (t.text) messages.push({ role: 'user', content: t.text })
      } else if (t.kind === 'assistant') {
        const content: Record<string, unknown>[] = []
        // Anthropic：thinking 块必须带签名才能回传；无签名（如来自其他协议的记录）时跳过
        for (const r of t.reasoning) {
          if (r.signature) content.push({ type: 'thinking', thinking: r.text, signature: r.signature })
        }
        if (t.text) content.push({ type: 'text', text: t.text })
        for (const c of t.toolCalls) {
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: parseToolInput(c.argsJson, c.name) })
        }
        if (content.length) messages.push({ role: 'assistant', content })
      } else {
        messages.push({
          role: 'user',
          content: t.results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.toolUseId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        })
      }
    }
    // 思考力度 → Anthropic extended thinking（预算随档位，max_tokens 必须大于预算）
    const effort = llm.thinkingEffort && llm.thinkingEffort !== 'off' ? llm.thinkingEffort : null
    const budget = effort ? { low: 2048, medium: 8192, high: 24576 }[effort] : 0
    return {
      url: joinURL(baseURL, '/v1/messages'),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: effort ? Math.max(MAX_TOKENS, budget + 4096) : MAX_TOKENS,
        ...(effort ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
        system,
        messages,
        stream,
        ...(tools.length
          ? { tools: tools.map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema })) }
          : {}),
      }),
    }
  }

  const messages: Record<string, unknown>[] = []
  for (const t of turns) {
    if (t.kind === 'user') {
      messages.push({ role: 'user', content: t.text })
    } else if (t.kind === 'assistant') {
      const reasoningText = t.reasoning.map((r) => r.text).join('\n')
      messages.push({
        role: 'assistant',
        content: t.text || null,
        // DeepSeek thinking 模式强制要求把上一轮的 reasoning_content 原样传回
        ...(reasoningText ? { reasoning_content: reasoningText } : {}),
        ...(t.toolCalls.length
          ? {
              tool_calls: t.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.argsJson || '{}' },
              })),
            }
          : {}),
      })
    } else {
      for (const r of t.results) {
        messages.push({ role: 'tool', tool_call_id: r.toolUseId, content: r.content })
      }
    }
  }
  return {
    url: joinURL(baseURL, '/chat/completions'),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream,
      // 思考力度 → OpenAI 系的 reasoning_effort；off 时不传（走模型默认，兼容不认识该字段的服务）
      ...(llm.thinkingEffort && llm.thinkingEffort !== 'off' ? { reasoning_effort: llm.thinkingEffort } : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(tools.length
        ? {
            tools: tools.map((d) => ({
              type: 'function',
              function: { name: d.name, description: d.description, parameters: d.inputSchema },
            })),
          }
        : {}),
    }),
  }
}

// ---------- SSE 流式解析 ----------

/** 用结构化类型而非 ReadableStream 具体类型，避免 DOM 与 Node 类型打架 */
type SSEBody = { getReader(): {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel?(): Promise<unknown>
  releaseLock?(): void
} }

export class LLMStreamError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'LLMStreamError'
  }
}

function streamError(json: Record<string, unknown>): LLMStreamError | null {
  if (json.type !== 'error' && !json.error) return null
  const detail = json.error && typeof json.error === 'object' ? json.error as Record<string, unknown> : json
  const type = typeof detail.type === 'string' ? detail.type : typeof detail.code === 'string' ? detail.code : ''
  const message = typeof detail.message === 'string' ? detail.message.slice(0, 300) : '模型服务返回流式错误'
  const retryable = /overload|server_error|rate_limit|timeout|internal/i.test(type)
  return new LLMStreamError(`模型流式响应错误${type ? `（${type}）` : ''}：${message}`, retryable)
}

export async function readSSE(
  body: SSEBody,
  onEvent: (json: Record<string, unknown> | null, rawData: string) => void,
  provider: LLMConfig['provider'] = 'openai-compatible',
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  let terminal = false
  let exhausted = false
  const notify = (json: Record<string, unknown> | null, raw: string): void => {
    try { onEvent(json, raw) } catch (error) {
      if (error instanceof LLMStreamError) throw error
      throw new LLMStreamError(`处理模型流式事件失败：${error instanceof Error ? error.message : String(error)}`, false)
    }
  }
  const dispatch = (): boolean => {
    if (!dataLines.length) return false // SSE comments/heartbeats have no data payload.
    const raw = dataLines.join('\n')
    dataLines = []
    if (raw.trim() === '[DONE]') {
      if (provider === 'anthropic') throw new LLMStreamError('Anthropic 响应在 message_stop 前结束，工具未执行', true)
      notify(null, '[DONE]')
      terminal = true
      return true
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      throw new LLMStreamError('模型流式事件包含无效或截断的 JSON，工具未执行', true)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LLMStreamError('模型流式事件格式无效，工具未执行', true)
    }
    const json = parsed as Record<string, unknown>
    notify(json, raw) // Handler failures must propagate, separately from JSON parsing failures.
    const error = streamError(json)
    if (error) throw error
    if (provider === 'anthropic') {
      if (json.type === 'message_stop') { terminal = true; return true }
    } else {
      const choices = json.choices as Array<{ finish_reason?: unknown }> | undefined
      if (Array.isArray(choices) && ['stop', 'tool_calls', 'function_call', 'length', 'content_filter'].includes(String(choices[0]?.finish_reason))) {
        terminal = true
      }
    }
    return false
  }
  const line = (value: string): boolean => {
    const normalized = value.endsWith('\r') ? value.slice(0, -1) : value
    if (!normalized) return dispatch()
    if (normalized.startsWith('data:')) dataLines.push(normalized.slice(5).replace(/^ /, ''))
    return false
  }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) { exhausted = true; buffer += decoder.decode(); break }
      buffer += decoder.decode(chunk.value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const value = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line(value)) return
      }
    }
    if (buffer && line(buffer)) return
    if (dispatch()) return
    if (!terminal) throw new LLMStreamError('模型流式响应在完成标记前中断，工具未执行', true)
  } finally {
    if (!exhausted) await reader.cancel?.().catch(() => {})
    reader.releaseLock?.()
  }
}

/**
 * 流式事件收集器：一边把文本增量/工具调用推给渲染进程，
 * 一边把本轮回复组装成 MessageBlock[]。
 * sink 参数：事件出口，默认主进程 emit；子代理传入空函数（增量不进主对话）。
 */
export function createStreamCollector(
  provider: LLMConfig['provider'],
  sessionId: string,
  sink: (e: ChatEvent) => void = emit,
): { onEvent: (json: Record<string, unknown>) => void; finish: () => { blocks: MessageBlock[]; reasoning: string } } {
  // OpenAI 兼容状态：文本一块 + tool_calls 按 index 累积 + 思考内容（reasoning_content）
  let oaText = ''
  let oaReasoning = ''
  let oaFinishReason: string | undefined
  let aStopReason: string | undefined
  const oaCalls = new Map<number, { id: string; name: string; args: string }>()
  // Anthropic 状态：content block 按 index 顺序排列
  const aItems: Array<
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string; signature: string }
    | { kind: 'tool'; id: string; name: string; args: string; initialInput: unknown }
  > = []
  const aClosed = new Set<number>()

  const onEvent = (json: Record<string, unknown>): void => {
    if (provider === 'anthropic') {
      const index = typeof json.index === 'number' ? json.index : -1
      if (json.type === 'content_block_start') {
        if (!Number.isSafeInteger(index) || index < 0) throw new LLMStreamError('Anthropic 内容块索引无效', true)
        const cb = json.content_block as { type?: string; id?: string; name?: string; input?: unknown; text?: string } | undefined
        aClosed.delete(index)
        if (cb?.type === 'tool_use') {
          if (typeof cb.id !== 'string' || !cb.id.trim() || typeof cb.name !== 'string' || !cb.name.trim()) {
            throw new LLMStreamError('Anthropic 工具调用缺少有效 id 或名称，工具未执行', true)
          }
          aItems[index] = { kind: 'tool', id: cb.id, name: cb.name, args: '', initialInput: cb.input }
        } else if (cb?.type === 'thinking') {
          aItems[index] = { kind: 'thinking', text: '', signature: '' }
        } else {
          aItems[index] = { kind: 'text', text: cb?.text ?? '' }
        }
      } else if (json.type === 'content_block_delta') {
        const item = aItems[index]
        const delta = json.delta as {
          type?: string
          text?: string
          thinking?: string
          signature?: string
          partial_json?: string
        } | undefined
        if (!item || !delta) return
        if (item.kind === 'text' && delta.type === 'text_delta' && delta.text) {
          item.text += delta.text
          sink({ type: 'delta', sessionId, delta: delta.text })
        } else if (item.kind === 'thinking' && delta.type === 'thinking_delta' && delta.thinking) {
          item.text += delta.thinking
          sink({ type: 'reasoning_delta', sessionId, delta: delta.thinking })
        } else if (item.kind === 'thinking' && delta.type === 'signature_delta' && delta.signature) {
          item.signature += delta.signature
        } else if (item.kind === 'tool' && delta.type === 'input_json_delta' && delta.partial_json) {
          item.args += delta.partial_json
        }
      } else if (json.type === 'content_block_stop') {
        if (aItems[index]) aClosed.add(index)
      } else if (json.type === 'message_delta') {
        const reason = (json.delta as { stop_reason?: unknown } | undefined)?.stop_reason
        if (typeof reason === 'string') aStopReason = reason
      }
      return
    }

    // OpenAI 兼容
    const choices = json.choices as
      | Array<{
          finish_reason?: string | null
          delta?: {
            content?: string
            reasoning_content?: string
            reasoning?: string
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
          }
        }>
      | undefined
    const delta = choices?.[0]?.delta
    if (choices?.[0]?.finish_reason) oaFinishReason = choices[0].finish_reason
    // 推理模型（如 DeepSeek）的思考内容：累积为 reasoning 块，随历史回传（thinking 模式强制要求）
    const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning
    if (reasoningDelta) {
      oaReasoning += reasoningDelta
      sink({ type: 'reasoning_delta', sessionId, delta: reasoningDelta })
    }
    if (delta?.content) {
      oaText += delta.content
      sink({ type: 'delta', sessionId, delta: delta.content })
    }
    for (const tc of delta?.tool_calls ?? []) {
      const idx = typeof tc.index === 'number' ? tc.index : oaCalls.size
      const slot = oaCalls.get(idx) ?? { id: '', name: '', args: '' }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name += tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
      oaCalls.set(idx, slot)
    }
  }

  const finish = (): { blocks: MessageBlock[]; reasoning: string } => {
    if (provider === 'anthropic') {
      let reasoning = ''
      const blocks: MessageBlock[] = []
      for (const [index, item] of aItems.entries()) {
        if (!item) continue
        if (!aClosed.has(index)) throw new LLMStreamError(`Anthropic 内容块 ${index} 未完成，工具未执行`, true)
        if (item.kind === 'text') {
          blocks.push({ type: 'text', text: item.text })
        } else if (item.kind === 'thinking') {
          reasoning = reasoning ? `${reasoning}\n${item.text}` : item.text
          if (item.text) {
            blocks.push({
              type: 'reasoning',
              text: item.text,
              ...(item.signature ? { signature: item.signature } : {}),
            })
          }
        } else {
          blocks.push({
            type: 'tool_use',
            id: item.id,
            name: item.name,
            input: parseToolInput(item.args || JSON.stringify(item.initialInput) || '', item.name),
            status: 'running',
          })
        }
      }
      if (blocks.some((block) => block.type === 'tool_use') && aStopReason !== 'tool_use') {
        throw new LLMStreamError(`Anthropic 工具响应未正常结束（${aStopReason ?? '缺少停止原因'}），工具未执行`, !aStopReason || aStopReason === 'max_tokens')
      }
      for (const block of blocks) if (block.type === 'tool_use') {
        sink({ type: 'tool_use', sessionId, toolUseId: block.id, name: block.name, input: block.input })
      }
      return { blocks, reasoning }
    }
    if (oaCalls.size && (oaFinishReason === 'length' || oaFinishReason === 'content_filter')) {
      throw new LLMStreamError('模型的工具响应被输出上限或内容过滤截断，工具未执行', oaFinishReason === 'length')
    }
    const callBlocks: MessageBlock[] = [...oaCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]): ToolUseBlock => {
        if (typeof c.id !== 'string' || !c.id.trim() || typeof c.name !== 'string' || !c.name.trim()) throw new LLMStreamError('模型返回的工具调用缺少 id 或名称，工具未执行', true)
        return { type: 'tool_use', id: c.id, name: c.name, input: parseToolInput(c.args, c.name), status: 'running' }
      })
    for (const block of callBlocks) if (block.type === 'tool_use') {
      sink({ type: 'tool_use', sessionId, toolUseId: block.id, name: block.name, input: block.input })
    }
    const blocks: MessageBlock[] = []
    if (oaReasoning) blocks.push({ type: 'reasoning', text: oaReasoning })
    if (oaText) blocks.push({ type: 'text', text: oaText })
    blocks.push(...callBlocks)
    return { blocks, reasoning: oaReasoning }
  }

  return { onEvent, finish }
}

// ---------- 代理循环 ----------

/** 工具执行的门禁上下文：主循环与子代理共用同一套钩子/批准/权限/检查点逻辑 */
interface ToolExecCtx {
  tools: ToolDefinition[]
  permissionRules: PermissionRules
  /** 实时读取批准模式（用户中途切换立即生效，不等下一轮） */
  getApprovalMode: () => ApprovalMode
  hooks?: HookConfig[]
  projectPath: string | null
  projectId: string
  sessionId: string
  signal: AbortSignal
  emit: (e: ChatEvent) => void
  onTodos: (todos: TodoItem[]) => void
}

/**
 * 执行一个工具调用（原地写 tu.status / tu.result / tu.durationMs）：
 * 检查点快照 → 权限规则（deny>ask>allow）→ 批准门（模式与规则综合裁定）→ 执行。
 * 每一步的事件（tool_result / approval_request）经 ctx.emit 送出。
 */
async function executeToolWithGates(tu: ToolUseBlock, ctx: ToolExecCtx): Promise<void> {
  const def = ctx.tools.find((d) => d.name === tu.name)
  if (!def) {
    const note = `工具 ${tu.name} 不在本次允许的工具列表中（已禁用、当前模式不可用或名称未知），操作未执行`
    tu.status = 'error'
    tu.result = note
    ctx.emit({ type: 'tool_result', sessionId: ctx.sessionId, toolUseId: tu.id, content: note, isError: true })
    return
  }
  // PreToolUse 钩子（先于权限规则）：可改写入参、跳过批准门、阻止执行
  const pre = await runPreToolUseHooks(ctx.hooks, {
    sessionId: ctx.sessionId,
    toolName: tu.name,
    toolInput: tu.input,
  })
  if (pre.updatedInput) tu.input = pre.updatedInput
  if (pre.blocked) {
    const note = pre.reason ?? '被 PreToolUse 钩子阻止'
    tu.status = 'error'
    tu.result = note
    ctx.emit({ type: 'tool_result', sessionId: ctx.sessionId, toolUseId: tu.id, content: note, isError: true })
    return
  }
  const verdict = evaluateRules(ctx.permissionRules, tu.name, tu.input)
  if (verdict === 'deny') {
    const note = '权限规则（deny）拒绝了此操作'
    tu.status = 'error'
    tu.result = note
    ctx.emit({ type: 'tool_result', sessionId: ctx.sessionId, toolUseId: tu.id, content: note, isError: true })
    return
  }
  // 完全访问 = 全部自动放行；自动编辑 = 文件编辑类自动放行；变更前确认 = 全部询问；
  // allow 规则强制放行，ask 规则强制询问（优先于模式）；PreToolUse 钩子 approve = 跳过批准门
  const autoApprove =
    pre.autoApprove ||
    (verdict === 'allow' ? true : verdict === 'ask' ? false : ctx.getApprovalMode() === 'fullAccess' || (ctx.getApprovalMode() === 'autoEdit' && def?.kind === 'edit'))
  if (def?.requiresApproval && !autoApprove) {
    // 批准门：循环在此挂起，等待用户在界面上点"允许/拒绝"
    const suggest = def.requiresApproval ? suggestRule(tu.name, tu.input) : undefined
    const outcome = await requestApproval(ctx.sessionId, tu.id, ctx.emit, suggest)
    if (outcome !== 'approved') {
      const note =
        outcome === 'timeout'
          ? '批准超时（120 秒无响应），操作未执行'
          : outcome === 'stopped'
            ? '用户停止了生成，操作未执行'
            : '用户拒绝了本次操作'
      tu.status = 'error'
      tu.result = note
      ctx.emit({ type: 'tool_result', sessionId: ctx.sessionId, toolUseId: tu.id, content: note, isError: true })
      return
    }
  }
  ctx.signal.throwIfAborted()
  // Snapshot only operations that passed the permission gate, including binary artifacts.
  if (def.kind === 'edit' && ctx.projectPath && typeof tu.input.path === 'string') {
    await snapshotFilesBeforeChange(sessionCheckpointsRoot(ctx.projectId, ctx.sessionId), tu.id, ctx.projectPath, [tu.input.path])
  }
  const result = await runToolUseBlock(tu, ctx.projectPath, {
    definition: def,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    onOutput: (text) => ctx.emit({ type: 'tool_output', sessionId: ctx.sessionId, toolUseId: tu.id, text }),
    onTodos: ctx.onTodos,
    onAskUser: async (q) => {
      const answer = await requestUserInput(ctx.sessionId, tu.id, q.question, q.options, ctx.emit)
      return answer
    },
  })
  tu.status = result.isError ? 'error' : 'done'
  tu.result = result.content
  tu.durationMs = result.durationMs
  // PostToolUse 钩子：可追加上下文（拼在工具结果后一起喂给模型）
  const hookContext = await runPostToolUseHooks(ctx.hooks, {
    sessionId: ctx.sessionId,
    toolName: tu.name,
    toolInput: tu.input,
    toolResult: result.content,
  })
  if (hookContext) tu.result = `${result.content}\n\n[hooks 附加上下文] ${hookContext}`
  ctx.emit({
    type: 'tool_result',
    sessionId: ctx.sessionId,
    toolUseId: tu.id,
    content: tu.result,
    isError: result.isError,
  })
}

/** Connections are shared with settings; cancel this task's wait without disabling them. */
async function waitForPreparation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { cleanup(); reject(signal.reason) }
    const cleanup = (): void => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    pending.then((value) => { cleanup(); resolve(value) }, (error) => { cleanup(); reject(error) })
    if (signal.aborted) aborted()
  })
}

async function chatSend(req: ChatRequest): Promise<{ ok: boolean; error?: string; compacted?: number }> {
  if (aborters.has(req.sessionId)) return { ok: false, error: '这个会话已有任务运行，请先停止或等待完成' }
  const controller = new AbortController()
  aborters.set(req.sessionId, controller)
  try { return await chatSendInternal(req, controller) }
  catch (error) {
    if (controller.signal.aborted) {
      emit({ type: 'done', sessionId: req.sessionId })
      return { ok: true }
    }
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', sessionId: req.sessionId, message })
    return { ok: false, error: message }
  } finally { if (aborters.get(req.sessionId) === controller) aborters.delete(req.sessionId) }
}

async function chatSendInternal(req: ChatRequest, controller: AbortController): Promise<{ ok: boolean; error?: string; compacted?: number }> {
  const cfg = await loadConfig()
  controller.signal.throwIfAborted()
  let llm = cfg.llmProfiles?.find((p) => p.id === cfg.activeLlmId) ?? cfg.llmProfiles?.[0] ?? null
  // 斜杠命令 frontmatter 的 model 覆盖：按模型名匹配配置档，找不到保持激活档
  const requestedModel = req.skill?.model?.trim()
  if (requestedModel) {
    const override = cfg.llmProfiles?.find((p) => p.model === requestedModel)
    if (override) llm = override
    else console.warn(`[skill] model 覆盖未命中配置档：${requestedModel}，使用当前激活档`)
  }
  if (!llm) return { ok: false, error: '尚未配置 LLM API，请先在设置中添加配置档' }
  const apiKey = decryptApiKey(llm.apiKey)
  if (!apiKey) return { ok: false, error: '当前配置档的 API Key 为空，请在设置中填写' }

  const office = req.projectId === 'office-workspace'
  const storedSession = office || req.revision !== undefined ? (await loadSessionAny(req.projectId, req.sessionId))?.session : null
  if (office && (!storedSession || storedSession.taskMode !== 'office')) return { ok: false, error: '办公任务不存在，请新建办公任务后继续' }
  if (req.revision !== undefined && req.revision !== storedSession?.revision) return { ok: false, error: '会话已被修改，请重新加载后继续' }
  const projectPath = office ? await (await import('./office')).ensureOfficeWorkspace(req.sessionId) : cfg.projects.find((p) => p.id === req.projectId)?.path ?? null
  // MCP 服务器：对话开始时按配置 diff 连接（新连/断开已移除的），其工具并入下面的工具池
  await waitForPreparation(ensureMcpConnections(cfg.mcpServers ?? []), controller.signal)
  controller.signal.throwIfAborted()
  // 工具池同时用于请求定义与执行门禁；被禁用的工具即使被模型请求也不会执行。
  // 规划模式：所有需要批准的工具（写/改/命令/MCP）都从工具池移除，只保留只读研究
  const officeTools = office ? (await import('./tools/office')).getOfficeToolDefinitions() : []
  const effSettings = resolveEffectiveSettings(cfg, office ? 'office' : 'coding')
  let tools = [...toolsForTaskMode(office ? 'office' : 'coding', getToolDefinitions(), officeTools), ...getMcpToolDefs(), ...getResourceTools()].filter((d) => effSettings.toolSwitches[d.name] !== false)
  const approvalMode = effSettings.approvalMode
  if (approvalMode === 'plan') {
    tools = tools.filter((d) => !d.requiresApproval)
  }
  const pricing = cfg.modelPricing?.find((p) => p.model === llm.model) ?? null
  const peak = isPeakTime(new Date(), cfg.holidays ?? [])
  const proxyURL = llm.proxyURL?.trim() || null
  // 上下文构成明细用：系统提示词与工具定义是我们自己的固定文本，可本地估算；
  // messages 部分用服务端总量减去这两项得出余量。
  // AGENTS.md（项目约定）在每轮对话开始时读取，存在则注入系统提示词。
  const agentsMd = !office && projectPath ? await loadAgentsMd(projectPath) : ''
  let systemText = office ? officeSystemPrompt(projectPath!) : buildSystemPrompt(projectPath, agentsMd)
  // 规划模式的系统提示：告知模型当前只读约束
  if (approvalMode === 'plan') {
    systemText +=
      '\n\n当前处于【规划模式】：所有修改类工具（写文件 / 编辑 / 执行命令）均不可用。请只做研究和制定计划：' +
      (office ? '阅读相关资料并给出办公任务计划，等待用户切换批准模式后生成文件。' : '阅读相关代码、理解现状，然后在回复中输出一份完整、可执行的改造计划（含要修改的文件与步骤），等待用户批准。用户批准并切换批准模式后，再按计划执行。')
  }
  const toolsText = JSON.stringify(
    tools.map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema })),
  )

  // 子代理（task 工具）：独立上下文里跑完整的"请求→工具→再请求"循环，
  // 进度实时挂到 task 工具卡片的"实时输出"区，最终报告作为 tool 结果回主对话。
  const subSystemPrompt = office ? systemText : buildSubagentSystemPrompt(
    'general-purpose',
    `项目目录：${projectPath ?? '（无项目）'}${agentsMd ? `\n\n项目约定（AGENTS.md）：\n${agentsMd}` : ''}`,
  )
  const subExecCtx: ToolExecCtx = {
    tools,
    permissionRules: effSettings.permissionRules,
    getApprovalMode: () => getApprovalMode(),
    hooks: cfg.hooks,
    projectPath,
    projectId: req.projectId,
    sessionId: req.sessionId,
    signal: controller.signal,
    emit: (e) => {
      // 子代理内部工具的结果/实时输出由 runSubagent 统一输出为进度行，不直接进主对话；
      // 批准卡与提问等会话级事件照常转发（用户在主界面看到并处理）
      if (e.type === 'tool_output' || e.type === 'tool_result') return
      emit(e)
    },
    onTodos: (todos) => {
      sessionTodos.set(req.sessionId, todos)
      emit({ type: 'todos', sessionId: req.sessionId, todos })
    },
  }
  let subRound = 0
  const subCallRound = async (
    messages: ChatHistoryMessage[],
    roundTools: ToolDefinition[],
    signal: AbortSignal,
    systemPrompt: string = subSystemPrompt,
  ): Promise<{ blocks: MessageBlock[] }> => {
    const { url, headers, body } = buildRequest(llm, apiKey, toApiTurns(messages), roundTools, true, systemPrompt)
    const exchange = beginExchange({
      sessionId: req.sessionId,
      profileId: llm.id,
      scope: 'subagent',
      kind: 'chat',
      round: ++subRound,
      llm,
      method: 'POST',
      url,
      proxyURL,
      pricing,
      peak,
      headers: maskHeaders(headers),
      body,
    })
    try {
      const res = await undiciFetch(url, {
        method: 'POST',
        headers,
        body,
        signal,
        dispatcher: getProxyDispatcher(llm.proxyURL ?? ''),
      })
      recordStatus(exchange, res.status)
      if (!res.ok || !res.body) {
        const detail = (await res.text().catch(() => '')).slice(0, 300)
        throw new HttpError(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`, res.status)
      }
      // 子代理的流式增量不进主对话：sink 传空函数，只取组装结果
      const collector = createStreamCollector(llm.provider, req.sessionId, () => {})
      await readSSE(res.body, (json, raw) => {
        recordSSELine(exchange, raw)
        if (!json) return
        recordUsageEvent(exchange, json)
        collector.onEvent(json)
      }, llm.provider)
      const fin = collector.finish()
      for (const block of fin.blocks) {
        if (block.type === 'tool_use' && !roundTools.some((tool) => tool.name === block.name)) {
          throw new LLMStreamError(`子代理请求了不在本轮允许列表中的工具 ${block.name}，操作未执行`, false)
        }
      }
      recordToolCalls(
        exchange,
        fin.blocks
          .filter((b): b is ToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, argsJson: JSON.stringify(b.input) })),
      )
      recordAssembledText(exchange, textOfBlocks(fin.blocks))
      endExchange(exchange)
      return fin
    } catch (err) {
      endExchange(exchange, isAbortError(err) ? undefined : err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  const taskTool = createTaskTool({
    baseTools: tools, // 不含 task 自身（固化在创建时；pickTools 再兜底排除递归）
    systemPrompt: subSystemPrompt,
    customTypes: cfg.subagentTypes ?? [],
    signal: controller.signal,
    callRound: subCallRound,
    executeTool: (tu) => executeToolWithGates(tu, subExecCtx),
  })
  if (effSettings.toolSwitches.task !== false) tools = [...tools, taskTool]

  // 斜杠命令 frontmatter 的 allowed-tools：本轮流式对话只可用列出的工具（最终门）
  const allowedTools = req.skill?.allowedTools?.filter(Boolean)
  if (allowedTools?.length) tools = tools.filter((d) => allowedTools.includes(d.name))

  // 发送前裁剪：估算超过上下文上限的 70%（预留输出与估算误差）时，
  // 从最旧的整组开始丢弃。只影响请求体；会话文件与界面历史保持完整。
  const conversation: HistoryMessage[] = req.messages.map((m) => ({ role: m.role, blocks: m.blocks }))
  const contextWindow = resolveModelContext(llm)?.contextWindow ?? 0
  const historyBudget = contextWindow > 0 ? Math.floor(contextWindow * 0.7) : Number.POSITIVE_INFINITY
  const trim = trimHistory(conversation, historyBudget)
  const working = trim.kept

  // 摘要压缩：被裁前缀值得摘要时，先用模型生成结构化摘要合并进保留部分，
  // 而不是静默丢弃。同一会话缓存复用（前缀覆盖即可），失败回退为直接裁剪。
  let requestMessages: ChatHistoryMessage[] = working
  let compactedCount = 0
  if (trim.trimmed && trim.trimmedCount > 0) {
    const dropped = conversation.slice(0, trim.trimmedCount)
    const cache = getCachedCompact(req.sessionId)
    if (cache && cache.droppedCount >= trim.trimmedCount) {
      requestMessages = mergeSummaryIntoFirstUser(working, cache.summaryText)
      compactedCount = cache.droppedCount
    } else if (worthSummarizing(dropped)) {
      emit({ type: 'status', sessionId: req.sessionId, text: `正在压缩早期 ${dropped.length} 条对话为摘要…` })
      try {
        const summary = await summarizeWithModel({
          llm,
          apiKey,
          dispatcher: getProxyDispatcher(llm.proxyURL ?? ''),
          dropped,
          signal: controller.signal,
        })
        requestMessages = mergeSummaryIntoFirstUser(working, summary)
        compactedCount = trim.trimmedCount
        // 摘要落盘：随会话文件持久化，重启后无需重新花一次摘要 API 调用
        const saved = await appendSummaryLine(req.projectId, req.sessionId, trim.trimmedCount, summary, req.revision)
        if (!saved.ok && saved.conflict) {
          const message = '压缩期间会话历史已被其他操作修改，本轮已停止；请重新加载会话后继续'
          controller.abort()
          aborters.delete(req.sessionId)
          emit({ type: 'error', sessionId: req.sessionId, message })
          return { ok: false, error: message }
        }
        if (!saved.ok) console.error('[compact] 摘要未能落盘（本轮仍使用内存摘要）:', saved.error)
        setCachedCompact(req.sessionId, trim.trimmedCount, summary)
      } catch {
        // 摘要失败：静默回退为直接裁剪，不影响本轮对话
      }
    }
  }

  // micro 压缩：逼近水位时把早期工具结果清成占位符（保留调用结构，无模型调用，幂等）
  const micro = microCompactHistory(requestMessages, { limit: cfg.contextLimit ?? 0 })
  if (micro.cleared > 0) {
    requestMessages = micro.messages
    console.info(`[microCompact] 已清理 ${micro.cleared} 条早期工具结果（约省 ${micro.charsSaved} 字符）`)
  }

  // 单轮请求：构建请求 → 流式读取 → 落调试记录 → 返回本轮 blocks。
  // 失败时（含中途断流）endExchange 后抛出，交给 withRetry 决定是否整轮重试。
  const attemptRound = async (round: number, roundTools = tools): Promise<{ blocks: MessageBlock[]; reasoning: string }> => {
    const { url, headers, body } = buildRequest(llm, apiKey, toApiTurns(requestMessages), roundTools, true, systemText)
    const exchange = beginExchange({
      sessionId: req.sessionId,
      profileId: llm.id,
      scope: 'main',
      kind: 'chat',
      round,
      llm,
      method: 'POST',
      url,
      proxyURL,
      pricing,
      peak,
      trimmedCount: trim.trimmed ? trim.trimmedCount : undefined,
      headers: maskHeaders(headers),
      body,
    })
    try {
      const dispatcher = getProxyDispatcher(llm.proxyURL ?? '')
      const res = await undiciFetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        dispatcher,
      })
      recordStatus(exchange, res.status)
      if (!res.ok || !res.body) {
        const detail = (await res.text().catch(() => '')).slice(0, 300)
        // Retry-After 头（秒）→ 毫秒，withRetry 会优先尊重它
        const ra = parseFloat(res.headers.get('retry-after') ?? '')
        throw new HttpError(
          `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
          res.status,
          Number.isFinite(ra) ? ra * 1000 : undefined,
        )
      }

      const collector = createStreamCollector(llm.provider, req.sessionId)
      await readSSE(res.body, (json, raw) => {
        recordSSELine(exchange, raw)
        if (!json) return // [DONE] 结束标记
        recordUsageEvent(exchange, json)
        collector.onEvent(json)
      }, llm.provider)
      const fin = collector.finish()
      recordToolCalls(
        exchange,
        fin.blocks
          .filter((b): b is ToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, argsJson: JSON.stringify(b.input) })),
      )
      if (fin.reasoning) recordReasoningText(exchange, fin.reasoning)
      recordAssembledText(exchange, textOfBlocks(fin.blocks))
      // 上下文构成：总量用服务端 usage，系统/工具用本地估算，余量记为消息
      if (exchange.inputTokens != null) {
        const systemTokens = estimateTokens(systemText)
        const toolsTokens = estimateTokens(toolsText)
        recordContextBreakdown(exchange, {
          totalTokens: exchange.inputTokens,
          systemTokens,
          toolsTokens,
          messagesTokens: Math.max(0, exchange.inputTokens - systemTokens - toolsTokens),
          cacheHitTokens: exchange.cacheHitTokens,
          cacheHitRate: exchange.inputTokens > 0 ? (exchange.cacheHitTokens ?? 0) / exchange.inputTokens : null,
        })
      }
      endExchange(exchange)
      return fin
    } catch (err) {
      endExchange(exchange, isAbortError(err) ? undefined : err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  // 结束或异常时必须给已显示的工具卡发送终态，避免遗留永久“运行中”。
  let pendingTools: ToolUseBlock[] = []
  const failPendingTools = (message: string): void => {
    for (const tu of pendingTools) {
      if (tu.status === 'done' || tu.status === 'error') continue
      tu.status = 'error'
      tu.result = message
      emit({ type: 'tool_result', sessionId: req.sessionId, toolUseId: tu.id, content: message, isError: true })
    }
  }

  try {
    let round = 0
    while (true) {
      round++
      const finalRound = round > MAX_TOOL_ROUNDS
      if (finalRound) {
        emit({ type: 'status', sessionId: req.sessionId, text: `已完成 ${MAX_TOOL_ROUNDS} 轮工具调用，正在汇总当前进展…` })
        requestMessages.push({
          role: 'user',
          blocks: [{ type: 'text', text: '（系统提示：已达本次工具轮次上限。请基于已有工具结果汇总已完成的工作、未完成的工作及下一步，不要再调用工具，也不要将未完成的任务描述为已完成。用户可继续发送消息接续任务。）' }],
        })
      }
      // 请求韧性：网络错误 / 429 / 5xx / 529 指数退避重试；4xx 与用户中止不重试。
      // 每次重试前发 retry 事件，渲染端清掉已收到的半截回复并显示重试进度。
      const { blocks: assistantBlocks } = await withRetry({
        maxRetries: 4,
        signal: controller.signal,
        fn: () => attemptRound(round, finalRound ? [] : tools),
        shouldRetry: (err) =>
          !isAbortError(err) &&
          (err instanceof LLMStreamError ? err.retryable : err instanceof HttpError ? RETRYABLE_STATUS.has(err.status) : true),
        onRetry: async (info) => {
          emit({
            type: 'retry',
            sessionId: req.sessionId,
            attempt: info.attempt,
            maxRetries: info.maxRetries,
            waitMs: info.waitMs,
            reason: info.reason,
          })
        },
      })

      // working 与 requestMessages 通常是同一数组；只追加一次，避免每轮工具历史翻倍。
      requestMessages.push({ role: 'assistant', blocks: assistantBlocks })

      const toolUses = assistantBlocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
      pendingTools = toolUses
      if (toolUses.length === 0) {
        await runStopHooks(cfg.hooks, req.sessionId) // Stop 钩子：副作用型（通知/清理），失败不影响对话
        emit({ type: 'done', sessionId: req.sessionId })
        return { ok: true, compacted: compactedCount > 0 ? compactedCount : undefined }
      }
      if (finalRound) {
        const message = `已达单次回复最大工具轮次（${MAX_TOOL_ROUNDS}），本轮未执行额外工具，请继续对话`
        failPendingTools(message)
        emit({ type: 'error', sessionId: req.sessionId, message })
        return { ok: false, error: message, compacted: compactedCount > 0 ? compactedCount : undefined }
      }

      // 执行本轮的每个工具调用（批准门/权限规则/检查点见 executeToolWithGates）
      const execCtx: ToolExecCtx = {
        tools,
        permissionRules: effSettings.permissionRules,
        getApprovalMode: () => getApprovalMode(),
        hooks: cfg.hooks,
        projectPath,
        projectId: req.projectId,
        sessionId: req.sessionId,
        signal: controller.signal,
        emit,
        onTodos: (todos) => {
          sessionTodos.set(req.sessionId, todos)
          emit({ type: 'todos', sessionId: req.sessionId, todos })
        },
      }
      // 并行执行两类安全组合：纯只读工具（对齐 Claude Code）、纯 task 调用（并行子代理，
      // 按上限分批）；混合轮次与含写操作/需批准的轮次保持串行。
      // 等全部调用收尾后再传播异常，防止仍在运行的调用在会话结束后发出结果。
      const allReadOnly = toolUses.length > 1 && toolUses.every((tu) => isParallelSafe(tu, tools))
      const allTasks = toolUses.length > 1 && toolUses.every((tu) => tu.name === TASK_TOOL_NAME)
      if (allReadOnly || allTasks) {
        const batches = allTasks ? parallelBatches(toolUses) : [toolUses]
        for (const batch of batches) {
          const results = await Promise.allSettled(batch.map((tu) => executeToolWithGates(tu, execCtx)))
          const failed = results.find((result) => result.status === 'rejected')
          if (failed?.status === 'rejected') throw failed.reason
        }
      } else {
        for (const tu of toolUses) {
          await executeToolWithGates(tu, execCtx)
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    failPendingTools(controller.signal.aborted ? '用户停止了生成，操作中断' : `任务中断：${message}`)
    if (controller.signal.aborted) {
      emit({ type: 'done', sessionId: req.sessionId }) // 用户手动停止，按正常结束处理
      return { ok: true }
    }
    emit({ type: 'error', sessionId: req.sessionId, message })
    return { ok: false, error: message }
  } finally {
    aborters.delete(req.sessionId)
  }
}

export function registerChatHandlers(): void {
  ipcMain.handle('chat:send', (_e, req: ChatRequest) => chatSend(req))

  ipcMain.handle('chat:stop', (_e, sessionId: string) => {
    aborters.get(sessionId)?.abort()
    stopSessionShellTasks(sessionId)
    resolveSessionApprovals(sessionId) // 挂起中的批准按"已停止"处理，循环随即收尾
    resolveSessionUserInputs(sessionId) // 挂起中的提问按"已停止"收尾
    return true
  })

  // 测试连接：允许用尚未保存的表单值；apiKey 留空时回退到对应配置档（编辑中）或激活配置档已存的 key
  ipcMain.handle('llm:test', async (_e, payload?: LLMTestPayload): Promise<{ ok: boolean; message: string }> => {
    try {
      const cfg = await loadConfig()
      const profiles = cfg.llmProfiles ?? []
      const byId = payload?.id ? profiles.find((p) => p.id === payload.id) : undefined
      const active = profiles.find((p) => p.id === cfg.activeLlmId) ?? profiles[0]
      const source = byId ?? active
      const llm: LLMConfig = {
        provider: payload?.provider ?? source?.provider ?? 'openai-compatible',
        name: payload?.name ?? 'test',
        baseURL: payload?.baseURL ?? source?.baseURL ?? '',
        model: payload?.model ?? source?.model ?? '',
        proxyURL: payload?.proxyURL ?? source?.proxyURL ?? '',
      }
      const apiKey = payload?.apiKey?.trim() || decryptApiKey(byId?.apiKey ?? active?.apiKey ?? '')
      if (!apiKey) return { ok: false, message: 'API Key 为空' }
      if (!llm.model) return { ok: false, message: '模型名不能为空' }

      const { url, headers, body } = buildRequest(llm, apiKey, [{ kind: 'user', text: 'ping' }], [], false, SYSTEM_PROMPT_BASE)
      const exchange = beginExchange({
        kind: 'test',
        round: 0,
        llm,
        method: 'POST',
        url,
        proxyURL: llm.proxyURL?.trim() || null,
        pricing: cfg.modelPricing?.find((p) => p.model === llm.model) ?? null,
        peak: isPeakTime(new Date(), cfg.holidays ?? []),
        headers: maskHeaders(headers),
        body,
      })
  // 拉取服务商模型列表（OpenAI 兼容 GET /models；key 解析规则与 llm:test 一致）
  ipcMain.handle(
    'llm:listModels',
    async (_e, payload?: LLMTestPayload): Promise<{ ok: boolean; models: { id: string; name?: string }[]; error?: string }> => {
      try {
        const cfg = await loadConfig()
        const profiles = cfg.llmProfiles ?? []
        const byId = payload?.id ? profiles.find((p) => p.id === payload.id) : undefined
        const active = profiles.find((p) => p.id === cfg.activeLlmId) ?? profiles[0]
        const source = byId ?? active
        const baseURL = (payload?.baseURL ?? source?.baseURL ?? '').trim()
        const apiKey = payload?.apiKey?.trim() || decryptApiKey(byId?.apiKey ?? active?.apiKey ?? '')
        if (!baseURL) return { ok: false, models: [], error: 'Base URL 为空' }
        if (!apiKey) return { ok: false, models: [], error: 'API Key 为空' }
        const { headers } = buildRequest(
          {
            provider: payload?.provider ?? source?.provider ?? 'openai-compatible',
            name: payload?.name ?? 'list',
            baseURL,
            model: payload?.model ?? '',
            proxyURL: payload?.proxyURL ?? source?.proxyURL ?? '',
          },
          apiKey,
          [{ kind: 'user', text: 'ping' }],
          [],
          false,
          '',
        )
        const dispatcher = getProxyDispatcher(payload?.proxyURL ?? source?.proxyURL ?? '')
        const res = await undiciFetch(joinURL(baseURL, '/models'), { headers, dispatcher, signal: AbortSignal.timeout(20_000) })
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 200)
          return { ok: false, models: [], error: `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}（该服务商可能不支持 /models 接口）` }
        }
        const data = (await res.json()) as { data?: Array<{ id?: string; name?: string }> }
        const models = (data.data ?? [])
          .map((m) => ({ id: String(m.id ?? ''), name: m.name ? String(m.name) : undefined }))
          .filter((m) => m.id)
        return { ok: true, models }
      } catch (e) {
        return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

      const dispatcher = getProxyDispatcher(llm.proxyURL ?? '')
      const res = await undiciFetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(20_000),
        dispatcher,
      })
      recordStatus(exchange, res.status)
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300)
        const message = `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`
        endExchange(exchange, message)
        return { ok: false, message }
      }
      const full = await res.text()
      // 非流式响应：usage 就在 JSON 里；顺便把原始响应记入调试日志
      try {
        recordUsageEvent(exchange, JSON.parse(full) as Record<string, unknown>)
      } catch {
        // 响应不是 JSON，忽略
      }
      endExchange(exchange)
      return { ok: true, message: `连接成功，模型 ${llm.model} 可用` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, message }
    }
  })
}
