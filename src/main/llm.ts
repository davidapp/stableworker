import { BrowserWindow, ipcMain } from 'electron'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import type { Dispatcher } from 'undici'
import { loadConfig, decryptApiKey } from './config'
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
import { requestApproval, resolveSessionApprovals } from './approvals'
import { snapshotFilesBeforeChange, sessionCheckpointsRoot } from './fileHistory'
import { getToolDefinitions, runToolUseBlock, type ToolDefinition } from './tools'
import { trimHistory } from './contextTrim'
import {
  mergeSummaryIntoFirstUser,
  summarizeWithModel,
  worthSummarizing,
  getCachedCompact,
  setCachedCompact,
} from './compact'
import { appendSummaryLine } from './sessions'
import { loadAgentsMd } from './agentsMd'
import { withRetry, HttpError, RETRYABLE_STATUS, isAbortError } from './withRetry'
import { estimateTokens } from '../shared/tokens'
import { recordContextBreakdown } from './debug'
import type {
  ChatEvent,
  ChatRequest,
  ChatHistoryMessage,
  LLMConfig,
  LLMTestPayload,
  MessageBlock,
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
const MAX_TOOL_ROUNDS = 8

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
  const agentsBlock = agentsMd ? `\n\n以下是本项目的约定（项目根 AGENTS.md），请严格遵守：\n${agentsMd}` : ''
  return `${SYSTEM_PROMPT_BASE}\n当前项目目录：${projectPath}\n你可以调用工具查看项目文件：了解目录结构用 list_files，查看文件内容用 read_file。涉及项目内容的问题先查再答，不要凭空猜测。${agentsBlock}`
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

function parseLooseJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
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
  return turns
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
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: parseLooseJson(c.argsJson) })
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
type SSEBody = { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } }

async function readSSE(
  body: SSEBody,
  onEvent: (json: Record<string, unknown> | null, rawData: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        onEvent(null, '[DONE]')
        return
      }
      try {
        onEvent(JSON.parse(data) as Record<string, unknown>, data)
      } catch {
        // 跳过无法解析的行（心跳等）
      }
    }
  }
}

/**
 * 流式事件收集器：一边把文本增量/工具调用推给渲染进程，
 * 一边把本轮回复组装成 MessageBlock[]。
 */
function createStreamCollector(
  provider: LLMConfig['provider'],
  sessionId: string,
): { onEvent: (json: Record<string, unknown>) => void; finish: () => { blocks: MessageBlock[]; reasoning: string } } {
  // OpenAI 兼容状态：文本一块 + tool_calls 按 index 累积 + 思考内容（reasoning_content）
  let oaText = ''
  let oaReasoning = ''
  const oaCalls = new Map<number, { id: string; name: string; args: string }>()
  // Anthropic 状态：content block 按 index 顺序排列
  const aItems: Array<
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string; signature: string }
    | { kind: 'tool'; id: string; name: string; args: string }
  > = []

  const onEvent = (json: Record<string, unknown>): void => {
    if (provider === 'anthropic') {
      const index = typeof json.index === 'number' ? json.index : -1
      if (json.type === 'content_block_start') {
        const cb = json.content_block as { type?: string; id?: string; name?: string } | undefined
        if (cb?.type === 'tool_use' && cb.id && cb.name) {
          aItems[index] = { kind: 'tool', id: cb.id, name: cb.name, args: '' }
        } else if (cb?.type === 'thinking') {
          aItems[index] = { kind: 'thinking', text: '', signature: '' }
        } else {
          aItems[index] = { kind: 'text', text: '' }
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
          emit({ type: 'delta', sessionId, delta: delta.text })
        } else if (item.kind === 'thinking' && delta.type === 'thinking_delta' && delta.thinking) {
          item.text += delta.thinking
          emit({ type: 'reasoning_delta', sessionId, delta: delta.thinking })
        } else if (item.kind === 'thinking' && delta.type === 'signature_delta' && delta.signature) {
          item.signature += delta.signature
        } else if (item.kind === 'tool' && delta.type === 'input_json_delta' && delta.partial_json) {
          item.args += delta.partial_json
        }
      } else if (json.type === 'content_block_stop') {
        const item = aItems[index]
        if (item && item.kind === 'tool') {
          emit({ type: 'tool_use', sessionId, toolUseId: item.id, name: item.name, input: parseLooseJson(item.args) })
        }
      }
      return
    }

    // OpenAI 兼容
    const choices = json.choices as
      | Array<{
          delta?: {
            content?: string
            reasoning_content?: string
            reasoning?: string
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
          }
        }>
      | undefined
    const delta = choices?.[0]?.delta
    // 推理模型（如 DeepSeek）的思考内容：累积为 reasoning 块，随历史回传（thinking 模式强制要求）
    const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning
    if (reasoningDelta) {
      oaReasoning += reasoningDelta
      emit({ type: 'reasoning_delta', sessionId, delta: reasoningDelta })
    }
    if (delta?.content) {
      oaText += delta.content
      emit({ type: 'delta', sessionId, delta: delta.content })
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
      for (const item of aItems) {
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
            input: parseLooseJson(item.args),
            status: 'running',
          })
        }
      }
      return { blocks, reasoning }
    }
    const callBlocks: MessageBlock[] = [...oaCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, c]): MessageBlock => {
        const id = c.id || `call_${idx}`
        const input = parseLooseJson(c.args)
        emit({ type: 'tool_use', sessionId, toolUseId: id, name: c.name, input })
        return { type: 'tool_use', id, name: c.name, input, status: 'running' }
      })
    const blocks: MessageBlock[] = []
    if (oaReasoning) blocks.push({ type: 'reasoning', text: oaReasoning })
    if (oaText) blocks.push({ type: 'text', text: oaText })
    blocks.push(...callBlocks)
    return { blocks, reasoning: oaReasoning }
  }

  return { onEvent, finish }
}

// ---------- 代理循环 ----------

async function chatSend(req: ChatRequest): Promise<{ ok: boolean; error?: string; compacted?: number }> {
  const cfg = await loadConfig()
  const llm = cfg.llmProfiles?.find((p) => p.id === cfg.activeLlmId) ?? cfg.llmProfiles?.[0] ?? null
  if (!llm) return { ok: false, error: '尚未配置 LLM API，请先在设置中添加配置档' }
  const apiKey = decryptApiKey(llm.apiKey)
  if (!apiKey) return { ok: false, error: '当前配置档的 API Key 为空，请在设置中填写' }

  const projectPath = cfg.projects.find((p) => p.id === req.projectId)?.path ?? null
  // 工具开关：被禁用的工具不随请求发给模型（模型不知道 = 不会调用）
  const tools = getToolDefinitions().filter((d) => cfg.toolSwitches?.[d.name] !== false)
  const pricing = cfg.modelPricing?.find((p) => p.model === llm.model) ?? null
  const peak = isPeakTime(new Date(), cfg.holidays ?? [])
  const proxyURL = llm.proxyURL?.trim() || null
  const approvalMode = cfg.approvalMode ?? 'confirm'
  // 上下文构成明细用：系统提示词与工具定义是我们自己的固定文本，可本地估算；
  // messages 部分用服务端总量减去这两项得出余量。
  // AGENTS.md（项目约定）在每轮对话开始时读取，存在则注入系统提示词。
  const agentsMd = projectPath ? await loadAgentsMd(projectPath) : ''
  const systemText = buildSystemPrompt(projectPath, agentsMd)
  const toolsText = JSON.stringify(
    tools.map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema })),
  )

  const controller = new AbortController()
  aborters.set(req.sessionId, controller)

  // 发送前裁剪：估算超过上下文上限的 70%（预留输出与估算误差）时，
  // 从最旧的整组开始丢弃。只影响请求体；会话文件与界面历史保持完整。
  const conversation: HistoryMessage[] = req.messages.map((m) => ({ role: m.role, blocks: m.blocks }))
  const historyBudget = (cfg.contextLimit ?? 0) > 0 ? Math.floor((cfg.contextLimit ?? 0) * 0.7) : Number.POSITIVE_INFINITY
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
        setCachedCompact(req.sessionId, trim.trimmedCount, summary)
        // 摘要落盘：随会话文件持久化，重启后无需重新花一次摘要 API 调用
        void appendSummaryLine(req.projectId, req.sessionId, trim.trimmedCount, summary).catch((e) => {
          console.error('[compact] 摘要落盘失败（内存缓存仍有效）:', e)
        })
      } catch {
        // 摘要失败：静默回退为直接裁剪，不影响本轮对话
      }
    }
  }

  // 单轮请求：构建请求 → 流式读取 → 落调试记录 → 返回本轮 blocks。
  // 失败时（含中途断流）endExchange 后抛出，交给 withRetry 决定是否整轮重试。
  const attemptRound = async (round: number): Promise<{ blocks: MessageBlock[]; reasoning: string }> => {
      const { url, headers, body } = buildRequest(llm, apiKey, toApiTurns(requestMessages), tools, true, systemText)
    const exchange = beginExchange({
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
      })
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

  try {
    let round = 0
    while (true) {
      round++
      // 请求韧性：网络错误 / 429 / 5xx / 529 指数退避重试；4xx 与用户中止不重试。
      // 每次重试前发 retry 事件，渲染端清掉已收到的半截回复并显示重试进度。
      const { blocks: assistantBlocks } = await withRetry({
        maxRetries: 4,
        signal: controller.signal,
        fn: () => attemptRound(round),
        shouldRetry: (err) =>
          !isAbortError(err) &&
          (err instanceof HttpError ? RETRYABLE_STATUS.has(err.status) : true),
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

      conversation.push({ role: 'assistant', blocks: assistantBlocks })
      working.push({ role: 'assistant', blocks: assistantBlocks })
      requestMessages.push({ role: 'assistant', blocks: assistantBlocks })

      const toolUses = assistantBlocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
      if (toolUses.length === 0) {
        emit({ type: 'done', sessionId: req.sessionId })
        return { ok: true, compacted: compactedCount > 0 ? compactedCount : undefined }
      }
      if (round >= MAX_TOOL_ROUNDS) {
        const message = `已达单次回复最大工具轮次（${MAX_TOOL_ROUNDS}），请继续对话`
        emit({ type: 'error', sessionId: req.sessionId, message })
        return { ok: false, error: message, compacted: compactedCount > 0 ? compactedCount : undefined }
      }

      // 执行本轮的每个工具调用：危险操作按批准模式决定是否先过批准门
      for (const tu of toolUses) {
        const def = tools.find((d) => d.name === tu.name)
        // 文件编辑类工具：执行前把目标文件快照进检查点（回滚用）
        if (def?.kind === 'edit' && projectPath && typeof tu.input.path === 'string') {
          await snapshotFilesBeforeChange(
            sessionCheckpointsRoot(req.projectId, req.sessionId),
            tu.id,
            projectPath,
            [tu.input.path],
          )
        }
        // 完全访问 = 全部自动放行；自动编辑 = 文件编辑类自动放行；变更前确认 = 全部询问
        const autoApprove =
          approvalMode === 'fullAccess' || (approvalMode === 'autoEdit' && def?.kind === 'edit')
        if (def?.requiresApproval && !autoApprove) {
          // 批准门：循环在此挂起，等待用户在界面上点"允许/拒绝"
          const outcome = await requestApproval(req.sessionId, tu.id, emit)
          if (outcome !== 'approved') {
            const note =
              outcome === 'timeout'
                ? '批准超时（120 秒无响应），操作未执行'
                : outcome === 'stopped'
                  ? '用户停止了生成，操作未执行'
                  : '用户拒绝了本次操作'
            tu.status = 'error'
            tu.result = note
            emit({
              type: 'tool_result',
              sessionId: req.sessionId,
              toolUseId: tu.id,
              content: note,
              isError: true,
            })
            continue
          }
        }
        const result = await runToolUseBlock(tu, projectPath, {
          signal: controller.signal,
          onOutput: (text) => emit({ type: 'tool_output', sessionId: req.sessionId, toolUseId: tu.id, text }),
        })
        tu.status = result.isError ? 'error' : 'done'
        tu.result = result.content
        tu.durationMs = result.durationMs
        emit({
          type: 'tool_result',
          sessionId: req.sessionId,
          toolUseId: tu.id,
          content: result.content,
          isError: result.isError,
        })
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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
    resolveSessionApprovals(sessionId) // 挂起中的批准按"已停止"处理，循环随即收尾
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
