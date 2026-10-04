import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { computeCost } from './pricing'
import type { DebugDetail, DebugListItem, LLMConfig, ModelPricing, Money } from '../shared/types'

/**
 * API 调用检查器（学习用途）：
 * 主进程把每次 LLM HTTP 交换的原始内容记录下来——请求 URL/头/体、逐条 SSE data 行、
 * 拼装后的最终文本、token 用量与费用、耗时、错误。
 *
 * 存储：永久保存在 userData/api_log/<startedAt>-<id>.json，一个调用一个文件；
 * 内存里只留最近 100 条完整记录（列表秒开），更早的按需从磁盘读取。
 * 敏感头（API Key）已脱敏；"清空"会删除磁盘上的全部记录。
 *
 * 费用：API 返回的是 token 用量而非金额。usage.cost 直接给出金额的服务商
 * （如 OpenRouter）按报告值记账；否则按请求时快照的模型价格表精确计算（见 pricing.ts）。
 */

const MAX_EVENTS_PER_EXCHANGE = 800
const MEMORY_LIMIT = 100
const SAVE_DEBOUNCE_MS = 500

interface Exchange {
  id: string
  kind: 'chat' | 'test'
  /** 工具调用回合序号（1 起）；0 = 非对话请求 */
  round: number
  startedAt: number
  endedAt: number | null
  provider: string
  model: string
  method: string
  url: string
  /** 经过代理时的代理地址；null = 直连 */
  proxyURL: string | null
  requestHeaders: Record<string, string>
  requestBody: string
  status: number | null
  sseEvents: string[]
  /** 收到的 data 行总数（与 sseEvents 分开记，因为 sseEvents 有条数上限） */
  eventCount: number
  assembledText: string
  /** 推理模型的思考内容（reasoning_content / thinking）；按协议约定不回传给后续请求 */
  reasoningText: string
  /** 本轮模型发起的工具调用（从响应解析；工具结果在下一轮请求体里可见） */
  toolCalls: { id: string; name: string; argsJson: string }[]
  /** 响应中的原始 usage 对象（最后一次出现的） */
  usage: unknown
  inputTokens: number | null
  outputTokens: number | null
  /** 缓存命中/未命中的输入拆分（按 usage 里的对应字段提取） */
  cacheHitTokens: number | null
  cacheMissTokens: number | null
  /** 本次费用（精确十进制字符串）；null = 未能计费 */
  cost: Money | null
  /** 请求时快照的模型价格表；null = 配置里没有该模型的价格 */
  pricing: ModelPricing | null
  /** 请求发起时刻（北京时间）是否高峰时段 */
  peak: boolean
  /** 非流式请求（测试连接）的原始响应体 */
  responseBody: string | null
  error: string | null
}

/** 完整记录（最新在前，最多 MEMORY_LIMIT 条） */
const recent: Exchange[] = []
/** 更早记录只有列表元数据，详情按需读盘 */
const olderMeta: DebugListItem[] = []
const fileNames = new Map<string, string>()

const dirty = new Set<Exchange>()
let saveTimer: NodeJS.Timeout | null = null
let writeChain: Promise<void> = Promise.resolve()

function notifyUpdated(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('debug:updated')
  }
}

// ---------- 持久化 ----------

function logDir(): string {
  return join(app.getPath('userData'), 'api_log')
}

function fileNameOf(ex: { startedAt: number; id: string }): string {
  return `${ex.startedAt}-${ex.id}.json`
}

function scheduleSave(ex: Exchange): void {
  dirty.add(ex)
  if (!saveTimer) saveTimer = setTimeout(() => void flushDirty(), SAVE_DEBOUNCE_MS)
}

/** 把脏记录串行写盘（防并发交错；同一份最新状态重复写也无害） */
async function flushDirty(): Promise<void> {
  saveTimer = null
  const batch = [...dirty]
  dirty.clear()
  for (const ex of batch) {
    const name = fileNameOf(ex)
    fileNames.set(ex.id, name)
    const data = JSON.stringify(ex)
    writeChain = writeChain
      .then(async () => {
        await mkdir(logDir(), { recursive: true })
        await writeFile(join(logDir(), name), data, 'utf-8')
      })
      .catch((err) => console.error('[debug] 写入 API 日志失败:', err))
  }
  await writeChain
}

/** 启动时从磁盘恢复历史记录 */
export async function initDebugLog(): Promise<void> {
  try {
    const files = (await readdir(logDir())).filter((f) => f.endsWith('.json'))
    const loaded: Exchange[] = []
    for (const f of files) {
      try {
        const ex = JSON.parse(await readFile(join(logDir(), f), 'utf-8')) as Exchange
        fileNames.set(ex.id, f)
        loaded.push(ex)
      } catch {
        // 单个文件损坏不拖垮整体
      }
    }
    loaded.sort((a, b) => b.startedAt - a.startedAt)
    recent.push(...loaded.slice(0, MEMORY_LIMIT))
    olderMeta.push(...loaded.slice(MEMORY_LIMIT).map(toListItem))
  } catch {
    // 目录不存在 = 还没有历史记录
  }
  notifyUpdated()
}

// ---------- 记录写入（由 llm.ts 调用） ----------

export function beginExchange(input: {
  kind: Exchange['kind']
  llm: LLMConfig
  method: string
  url: string
  proxyURL: string | null
  pricing: ModelPricing | null
  peak: boolean
  round?: number
  headers: Record<string, string>
  body: string
}): Exchange {
  const ex: Exchange = {
    id: randomUUID(),
    kind: input.kind,
    round: input.round ?? 0,
    startedAt: Date.now(),
    endedAt: null,
    provider: input.llm.provider,
    model: input.llm.model,
    method: input.method,
    url: input.url,
    proxyURL: input.proxyURL,
    requestHeaders: input.headers,
    requestBody: input.body,
    status: null,
    sseEvents: [],
    eventCount: 0,
    assembledText: '',
    reasoningText: '',
    toolCalls: [],
    usage: null,
    inputTokens: null,
    outputTokens: null,
    cacheHitTokens: null,
    cacheMissTokens: null,
    cost: null,
    pricing: input.pricing,
    peak: input.peak,
    responseBody: null,
    error: null,
  }
  recent.unshift(ex)
  // 超出内存上限的完整记录降级为列表元数据（文件仍在磁盘上）
  while (recent.length > MEMORY_LIMIT) {
    const evicted = recent.pop()
    if (evicted) olderMeta.unshift(toListItem(evicted))
  }
  scheduleSave(ex)
  notifyUpdated()
  return ex
}

export function recordStatus(ex: Exchange, status: number): void {
  ex.status = status
  scheduleSave(ex)
  notifyUpdated()
}

/** 记录一条原始 SSE data 行（保持线上格式，含最后的 [DONE]） */
export function recordSSELine(ex: Exchange, rawLine: string): void {
  ex.eventCount++
  if (ex.sseEvents.length < MAX_EVENTS_PER_EXCHANGE) ex.sseEvents.push(rawLine)
  scheduleSave(ex)
  notifyUpdated()
}

/** 记录本轮流式输出拼装出的最终文本（代理循环里每轮 API 调用各自一条记录） */
export function recordAssembledText(ex: Exchange, text: string): void {
  ex.assembledText = text
  scheduleSave(ex)
}

/** 记录推理模型的思考内容（reasoning_content / thinking，仅供观察，不回传给模型） */
export function recordReasoningText(ex: Exchange, text: string): void {
  ex.reasoningText = text
  scheduleSave(ex)
}

/** 记录本轮响应里解析出的工具调用（参数为原始 JSON 字符串） */
export function recordToolCalls(
  ex: Exchange,
  calls: { id: string; name: string; argsJson: string }[],
): void {
  ex.toolCalls = calls
  scheduleSave(ex)
}

/**
 * 从响应 JSON 中提取 usage 并重算费用。
 * - OpenAI 兼容：最后一个 chunk 的 usage（需请求里带 stream_options.include_usage，见 llm.ts），
 *   DeepSeek 额外返回 prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * - OpenAI 通用：prompt_tokens_details.cached_tokens；Anthropic：cache_read_input_tokens
 * - Anthropic：message_start 带输入、message_delta 累计输出
 * - usage.cost（如 OpenRouter）：直接是美元金额，优先采用
 */
export function recordUsageEvent(ex: Exchange, json: Record<string, unknown>): void {
  const usage = json.usage
  if (!usage || typeof usage !== 'object') return
  ex.usage = usage
  const u = usage as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined

  const input = num(u.prompt_tokens) ?? num(u.input_tokens)
  const output = num(u.completion_tokens) ?? num(u.output_tokens)
  const hit =
    num(u.prompt_cache_hit_tokens) ?? num(details?.cached_tokens) ?? num(u.cache_read_input_tokens) ?? 0
  const miss = num(u.prompt_cache_miss_tokens) ?? (input != null ? input - hit : null)

  if (input != null) ex.inputTokens = input
  if (output != null) ex.outputTokens = output
  if (input != null) ex.cacheHitTokens = hit
  if (miss != null) ex.cacheMissTokens = miss
  recomputeCost(ex)
  scheduleSave(ex)
  notifyUpdated()
}

function recomputeCost(ex: Exchange): void {
  const reported = (ex.usage as Record<string, unknown> | null)?.cost
  if (typeof reported === 'number') {
    // 服务商直接报告金额（如 OpenRouter），以报告值为准
    ex.cost = { currency: 'USD', amount: String(reported), source: 'provider' }
    return
  }
  if (!ex.pricing) {
    ex.cost = null
    return
  }
  ex.cost = computeCost({
    pricing: ex.pricing,
    peak: ex.peak,
    inputHit: ex.cacheHitTokens,
    inputMiss: ex.cacheMissTokens,
    output: ex.outputTokens,
  })
}

export function recordResponseBody(ex: Exchange, body: string): void {
  ex.responseBody = body
  scheduleSave(ex)
}

export function endExchange(ex: Exchange, error?: string): void {
  ex.endedAt = Date.now()
  if (error) ex.error = error
  notifyUpdated()
  dirty.add(ex)
  void flushDirty() // 完成的调用立即落盘
}

// ---------- 脱敏与视图 ----------

/** 脱敏：authorization / x-api-key 只保留末 4 位 */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase()
    if (lk === 'authorization' || lk === 'x-api-key') {
      const scheme = v.startsWith('Bearer ') ? 'Bearer ' : ''
      out[k] = `${scheme}••••${v.slice(-4)}（已脱敏）`
    } else {
      out[k] = v
    }
  }
  return out
}

function prettyJSON(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

function toListItem(ex: Exchange): DebugListItem {
  return {
    id: ex.id,
    kind: ex.kind,
    round: ex.round ?? 0,
    startedAt: ex.startedAt,
    durationMs: ex.endedAt ? ex.endedAt - ex.startedAt : null,
    provider: ex.provider,
    model: ex.model,
    url: ex.url,
    status: ex.status,
    error: ex.error,
    eventCount: ex.eventCount ?? ex.sseEvents?.length ?? 0, // 兼容旧版本文件
    inputTokens: ex.inputTokens ?? null,
    outputTokens: ex.outputTokens ?? null,
    cost: ex.cost ?? null,
  }
}

function toDetail(ex: Exchange): DebugDetail {
  return {
    ...toListItem(ex),
    method: ex.method,
    proxyURL: ex.proxyURL,
    peak: ex.peak ?? false,
    cacheHitTokens: ex.cacheHitTokens ?? null,
    cacheMissTokens: ex.cacheMissTokens ?? null,
    requestHeaders: ex.requestHeaders,
    requestBody: prettyJSON(ex.requestBody),
    sseEvents: ex.sseEvents,
    assembledText: ex.assembledText,
    reasoningText: ex.reasoningText ?? '',
    toolCalls: ex.toolCalls ?? [],
    usage: ex.usage,
    responseBody: ex.responseBody,
  }
}

// ---------- IPC ----------

export function registerDebugHandlers(): void {
  ipcMain.handle('debug:list', (): DebugListItem[] => [...recent.map(toListItem), ...olderMeta])

  ipcMain.handle('debug:get', async (_e, id: string): Promise<DebugDetail | null> => {
    const inMemory = recent.find((x) => x.id === id)
    if (inMemory) return toDetail(inMemory)
    // 更早的记录从磁盘读取
    const file = fileNames.get(id)
    if (!file) return null
    try {
      return toDetail(JSON.parse(await readFile(join(logDir(), file), 'utf-8')) as Exchange)
    } catch {
      return null
    }
  })

  ipcMain.handle('debug:clear', async (): Promise<boolean> => {
    recent.length = 0
    olderMeta.length = 0
    fileNames.clear()
    dirty.clear()
    await rm(logDir(), { recursive: true, force: true })
    notifyUpdated()
    return true
  })
}
