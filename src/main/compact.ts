import { fetch as undiciFetch } from 'undici'
import type { Dispatcher } from 'undici'
import type { ChatHistoryMessage, LLMConfig } from '../shared/types'
import { buildRequest } from './llm'
import { estimateTokens } from '../shared/tokens'

/**
 * 上下文摘要压缩（简化版 autoCompact）：
 * 历史超预算时，不直接丢弃最旧的整组对话，而是先用当前模型把被裁前缀
 * 压缩成一份结构化摘要，合并进保留部分的第一条用户消息——模型保住
 * "之前在干什么"的关键上下文，请求体积又回到了预算内。
 *
 * 摘要为每次请求临时生成（不写入会话文件）；同一会话由调用方缓存复用。
 */

const SUMMARY_SYSTEM = '你是会话摘要助手。把对话历史压缩成供 AI 助手继续工作的摘要，只输出摘要本身。'

export function buildSummaryUserPrompt(transcript: string): string {
  return [
    '请把下面的对话历史压缩成一份供 AI 助手继续工作的摘要。要求：',
    '1. 保留用户的原始目标，以及后续的调整与反馈',
    '2. 保留涉及到的文件路径与关键改动内容',
    '3. 保留已经做出的决定、未完成的事项、遗留的问题',
    '4. 重要的代码标识符 / 报错信息保留原文，代码片段只留签名不必全文',
    '5. 用简洁的要点列表输出，不要寒暄和解释',
    '',
    '=== 对话历史开始 ===',
    transcript,
    '=== 对话历史结束 ===',
  ].join('\n')
}

/** 把消息历史序列化成模型可读的纯文本（文本块全文，工具调用记名称+参数摘要） */
export function serializeTranscript(messages: ChatHistoryMessage[]): string {
  const lines: string[] = []
  let total = 0
  let truncated = false
  for (const m of messages) {
    for (const b of m.blocks) {
      let text: string
      if (b.type === 'text' || b.type === 'reasoning') text = b.text
      else {
        text = `[调用工具 ${b.name}，参数 ${JSON.stringify(b.input).slice(0, 300)}]`
        if (b.result) text += `\n[工具结果] ${b.result.slice(0, 2000)}`
      }
      if (total + text.length > MAX_TRANSCRIPT_CHARS) {
        truncated = true
        break
      }
      total += text.length
      lines.push(`${m.role === 'user' ? '用户' : '助手'}: ${text}`)
    }
    if (truncated) break
  }
  return truncated ? `${lines.join('\n')}\n…（过长，已截断）` : lines.join('\n')
}

const MAX_TRANSCRIPT_CHARS = 100_000

/** 把摘要合并进保留部分的第一条用户消息（协议要求角色交替，摘要以用户身份进入） */
export function mergeSummaryIntoFirstUser<T extends ChatHistoryMessage>(
  messages: T[],
  summary: string,
): T[] {
  const block = { type: 'text' as const, text: `[早期对话摘要（自动压缩，供参考）]\n${summary}` }
  const first = messages[0]
  if (!first) return [{ role: 'user', blocks: [block] }] as unknown as T[]
  if (first.role === 'user') {
    return [{ ...first, blocks: [block, ...first.blocks] } as T, ...messages.slice(1)]
  }
  // 保留部分以助手消息开头（罕见）：在前面插入一条合成用户消息
  return [{ role: 'user', blocks: [block] } as unknown as T, ...messages]
}

/** 从非流式响应 JSON 中解析摘要文本（双协议） */
export function parseSummaryResponse(provider: LLMConfig['provider'], json: Record<string, unknown>): string {
  if (provider === 'anthropic') {
    const content = json.content as Array<{ type?: string; text?: string }> | undefined
    return (content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  }
  const choices = json.choices as Array<{ message?: { content?: string } }> | undefined
  return choices?.[0]?.message?.content ?? ''
}

/** 被裁前缀是否值得摘要（≥2 条消息且估算 >300 tokens，否则静默丢弃更划算） */
export function worthSummarizing(dropped: ChatHistoryMessage[]): boolean {
  if (dropped.length < 2) return false
  const tokens = dropped.reduce(
    (acc, m) =>
      acc +
      m.blocks.reduce((a, b) => {
        if (b.type === 'text' || b.type === 'reasoning') return a + estimateTokens(b.text)
        return a + estimateTokens(b.name + JSON.stringify(b.input) + (b.result ?? ''))
      }, 0),
    0,
  )
  return tokens > 300
}

/** 用当前配置的模型做一次非流式摘要请求（失败由调用方兜底为直接裁剪） */
export async function summarizeWithModel(opts: {
  llm: LLMConfig
  apiKey: string
  dispatcher?: Dispatcher
  dropped: ChatHistoryMessage[]
  signal?: AbortSignal
}): Promise<string> {
  const prompt = buildSummaryUserPrompt(serializeTranscript(opts.dropped))
  const { url, headers, body } = buildRequest(
    opts.llm,
    opts.apiKey,
    [{ kind: 'user', text: prompt }],
    [], // 摘要请求不带工具
    false, // 非流式
    SUMMARY_SYSTEM,
  )
  const res = await undiciFetch(url, {
    method: 'POST',
    headers,
    body,
    signal: opts.signal,
    dispatcher: opts.dispatcher,
  })
  if (!res.ok) throw new Error(`摘要请求失败：HTTP ${res.status}`)
  const json = (await res.json()) as Record<string, unknown>
  const text = parseSummaryResponse(opts.llm.provider, json).trim()
  if (!text) throw new Error('摘要响应为空')
  return text
}
