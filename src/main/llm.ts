import { BrowserWindow, ipcMain } from 'electron'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import type { Dispatcher } from 'undici'
import { loadConfig, decryptApiKey } from './config'
import {
  beginExchange,
  recordStatus,
  recordSSELine,
  recordDelta,
  recordUsageEvent,
  recordResponseBody,
  endExchange,
  maskHeaders,
} from './debug'
import { isPeakTime } from './pricing'
import type { ChatEvent, ChatRequest, LLMConfig, LLMTestPayload, MessageRole } from '../shared/types'

/**
 * LLM 调用层：全部在主进程完成（API key 不出主进程、渲染进程没有跨域限制问题），
 * 流式增量通过单一 'chat:event' 通道推给渲染进程。
 *
 * 网络说明：Node 的全局 fetch 不读系统代理环境变量，所以代理走显式配置——
 * 配置了 proxyURL 时用 undici 的 ProxyAgent 挂 dispatcher，留空则直连。
 *
 * 当前支持两类协议：
 * - openai-compatible：POST {baseURL}/chat/completions（DeepSeek / GLM / Kimi / OpenRouter / vLLM…）
 * - anthropic：POST {baseURL}/v1/messages（Claude 官方 Messages API）
 *
 * 两者都是 SSE（server-sent events）流：一行行 "data: {json}"，
 * OpenAI 以 data: [DONE] 结束；Anthropic 用 type 字段区分事件。
 * 每次交换都会同步记录到 debug 模块，供"API 调试"面板观察协议细节。
 */

const SYSTEM_PROMPT = '你是 StableWorker，一个运行在用户本地电脑上的 AI 编程助手。回答简洁准确，使用与用户相同的语言。'
const MAX_TOKENS = 8192

/** sessionId → 中止控制器，支持"停止生成" */
const aborters = new Map<string, AbortController>()

/** 同一代理地址复用同一个 agent，避免重复建连开销 */
const proxyAgents = new Map<string, ProxyAgent>()

/**
 * 根据配置构建请求的 dispatcher：配置了代理返回 ProxyAgent，留空返回 undefined（直连）。
 * 代理地址非法时抛错，由调用方把错误记入调试日志并告知用户。
 */
function getProxyDispatcher(proxyURL: string): Dispatcher | undefined {
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

type HistoryMessage = { role: MessageRole; content: string }

function emit(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('chat:event', event)
  }
}

function defaultBaseURL(provider: LLMConfig['provider']): string {
  return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'
}

/** baseURL 去掉尾斜杠再拼路径，用户填带不带 /v1 都能工作 */
function joinURL(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

function buildRequest(
  llm: LLMConfig,
  apiKey: string,
  messages: HistoryMessage[],
  stream: boolean,
): { url: string; headers: Record<string, string>; body: string } {
  const baseURL = llm.baseURL.trim() || defaultBaseURL(llm.provider)

  if (llm.provider === 'anthropic') {
    return {
      url: joinURL(baseURL, '/v1/messages'),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: MAX_TOKENS, // Anthropic 必填
        system: SYSTEM_PROMPT, // Anthropic 的 system 是独立参数
        messages,
        stream,
      }),
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
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      stream,
      // 流式时让服务在最后一个 chunk 附带 usage（token 用量），这是计费依据
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    }),
  }
}

/** 从一条 SSE data JSON 中提取文本增量 */
function extractDelta(provider: LLMConfig['provider'], json: Record<string, unknown>): string {
  if (provider === 'anthropic') {
    if (json.type === 'content_block_delta') {
      const delta = json.delta as { text?: string } | undefined
      return delta?.text ?? ''
    }
    return ''
  }
  const choices = json.choices as Array<{ delta?: { content?: string } }> | undefined
  return choices?.[0]?.delta?.content ?? ''
}

/** 用结构化类型而非 ReadableStream 具体类型，避免 DOM 与 Node 类型打架 */
type SSEBody = { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } }

/**
 * 逐行读取 SSE 流。每条 "data: xxx" 行回调一次：
 * json 为 null 表示 OpenAI 的结束标记 [DONE]，其余情况是解析好的 JSON，
 * rawData 是去掉 "data: " 前缀后的原始文本（原样记录到调试日志）。
 */
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
      if (!line.startsWith('data:')) continue // 忽略空行 / event: / 注释行
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

async function chatSend(req: ChatRequest): Promise<{ ok: boolean; error?: string }> {
  const cfg = await loadConfig()
  if (!cfg.llm) return { ok: false, error: '尚未配置 LLM API，请先在设置中填写' }
  const llm = cfg.llm
  const apiKey = decryptApiKey(llm.apiKey)
  if (!apiKey) return { ok: false, error: 'API Key 为空，请在设置中填写' }

  const controller = new AbortController()
  aborters.set(req.sessionId, controller)
  const { url, headers, body } = buildRequest(llm, apiKey, req.messages, true)
  // 计费快照：价格表与高峰/空闲档位在请求发起时确定，之后改配置不影响这条记录
  const pricing = cfg.modelPricing?.find((p) => p.model === llm.model) ?? null
  const peak = isPeakTime(new Date(), cfg.holidays ?? [])
  const exchange = beginExchange({
    kind: 'chat',
    llm,
    method: 'POST',
    url,
    proxyURL: llm.proxyURL?.trim() || null,
    pricing,
    peak,
    headers: maskHeaders(headers),
    body,
  })

  try {
    const dispatcher = getProxyDispatcher(llm.proxyURL ?? '')
    const res = await undiciFetch(url, { method: 'POST', headers, body, signal: controller.signal, dispatcher })
    recordStatus(exchange, res.status)
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
    }
    await readSSE(res.body, (json, raw) => {
      recordSSELine(exchange, raw)
      if (!json) return // [DONE] 结束标记
      recordUsageEvent(exchange, json)
      const delta = extractDelta(llm.provider, json)
      if (delta) {
        recordDelta(exchange, delta)
        emit({ type: 'delta', sessionId: req.sessionId, delta })
      }
    })
    endExchange(exchange)
    emit({ type: 'done', sessionId: req.sessionId })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    endExchange(exchange, message)
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
    return true
  })

  // 测试连接：允许用尚未保存的表单值；apiKey 留空时用已保存的
  ipcMain.handle('llm:test', async (_e, payload?: LLMTestPayload): Promise<{ ok: boolean; message: string }> => {
    try {
      const cfg = await loadConfig()
      const llm: LLMConfig = {
        provider: payload?.provider ?? cfg.llm?.provider ?? 'openai-compatible',
        name: payload?.name ?? 'test',
        baseURL: payload?.baseURL ?? cfg.llm?.baseURL ?? '',
        model: payload?.model ?? cfg.llm?.model ?? '',
        proxyURL: payload?.proxyURL ?? cfg.llm?.proxyURL ?? '',
      }
      const apiKey = payload?.apiKey?.trim() || decryptApiKey(cfg.llm?.apiKey ?? '')
      if (!apiKey) return { ok: false, message: 'API Key 为空' }
      if (!llm.model) return { ok: false, message: '模型名不能为空' }

      const { url, headers, body } = buildRequest(llm, apiKey, [{ role: 'user', content: 'ping' }], false)
      const pricing = cfg.modelPricing?.find((p) => p.model === llm.model) ?? null
      const peak = isPeakTime(new Date(), cfg.holidays ?? [])
      const exchange = beginExchange({
        kind: 'test',
        llm,
        method: 'POST',
        url,
        proxyURL: llm.proxyURL?.trim() || null,
        pricing,
        peak,
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
      recordResponseBody(exchange, full.slice(0, 4000))
      endExchange(exchange)
      return { ok: true, message: `连接成功，模型 ${llm.model} 可用` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, message }
    }
  })
}
