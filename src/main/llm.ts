import { BrowserWindow, ipcMain } from 'electron'
import { loadConfig, decryptApiKey } from './config'
import type { ChatEvent, ChatRequest, LLMConfig, LLMTestPayload, MessageRole } from '../shared/types'

/**
 * LLM 调用层：全部在主进程完成（API key 不出主进程、渲染进程没有跨域限制问题），
 * 流式增量通过单一 'chat:event' 通道推给渲染进程。
 *
 * 当前支持两类协议：
 * - openai-compatible：POST {baseURL}/chat/completions（DeepSeek / GLM / Kimi / OpenRouter / vLLM…）
 * - anthropic：POST {baseURL}/v1/messages（Claude 官方 Messages API）
 *
 * 两者都是 SSE（server-sent events）流：一行行 "data: {json}"，
 * OpenAI 以 data: [DONE] 结束；Anthropic 用 type 字段区分事件。
 */

const SYSTEM_PROMPT = '你是 StableWorker，一个运行在用户本地电脑上的 AI 编程助手。回答简洁准确，使用与用户相同的语言。'
const MAX_TOKENS = 8192

/** sessionId → 中止控制器，支持"停止生成" */
const aborters = new Map<string, AbortController>()

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

async function readSSE(
  provider: LLMConfig['provider'],
  body: SSEBody,
  onDelta: (delta: string) => void,
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
      if (data === '[DONE]') return
      try {
        onDelta(extractDelta(provider, JSON.parse(data) as Record<string, unknown>))
      } catch {
        // 跳过无法解析的行（注释、心跳等）
      }
    }
  }
}

async function chatSend(req: ChatRequest): Promise<{ ok: boolean; error?: string }> {
  const cfg = await loadConfig()
  if (!cfg.llm) return { ok: false, error: '尚未配置 LLM API，请先在设置中填写' }
  const apiKey = decryptApiKey(cfg.llm.apiKey)
  if (!apiKey) return { ok: false, error: 'API Key 为空，请在设置中填写' }

  const controller = new AbortController()
  aborters.set(req.sessionId, controller)
  try {
    const { url, headers, body } = buildRequest(cfg.llm, apiKey, req.messages, true)
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
    }
    await readSSE(cfg.llm.provider, res.body, (delta) => {
      if (delta) emit({ type: 'delta', sessionId: req.sessionId, delta })
    })
    emit({ type: 'done', sessionId: req.sessionId })
    return { ok: true }
  } catch (err) {
    if (controller.signal.aborted) {
      emit({ type: 'done', sessionId: req.sessionId }) // 用户手动停止，按正常结束处理
      return { ok: true }
    }
    const message = err instanceof Error ? err.message : String(err)
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
      }
      const apiKey = payload?.apiKey?.trim() || decryptApiKey(cfg.llm?.apiKey ?? '')
      if (!apiKey) return { ok: false, message: 'API Key 为空' }
      if (!llm.model) return { ok: false, message: '模型名不能为空' }

      const { url, headers, body } = buildRequest(llm, apiKey, [{ role: 'user', content: 'ping' }], false)
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300)
        return { ok: false, message: `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}` }
      }
      return { ok: true, message: `连接成功，模型 ${llm.model} 可用` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}
