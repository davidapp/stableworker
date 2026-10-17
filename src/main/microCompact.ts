import type { ChatHistoryMessage, MessageBlock } from '../shared/types'
import { estimateTokens } from '../shared/tokens'

/**
 * micro 压缩（对齐 Claude Code 的 microCompact）：
 * 上下文逼近水位时，把**早期**工具调用的结果文本清成占位符——保留工具调用结构
 * （协议要求 tool_use 必须有配对的 tool_result），只丢内容细节。比整段摘要压缩
 * 便宜（无模型调用），且 recent 轮次的完整结果原样保留。
 *
 * 只作用于请求体（requestMessages），不改动会话文件与界面历史；
 * 幂等（占位符长度小于阈值，二次扫描不会重复清理），每轮请求可安全重跑。
 */

/** 上下文估算超过上限的该比例才触发（auto-compact 在 0.8，micro 更早介入） */
const MICRO_RATIO = 0.55
/** 最近 N 条助手消息的工具结果保留原样 */
const KEEP_RECENT_ASSISTANT = 2
/** 结果短于该字符数不值得清理 */
const MIN_RESULT_CHARS = 200
/** 占位符保留的结果预览长度 */
const PREVIEW_CHARS = 100

function headLine(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS) + '…' : s
}

function tokensOf(blocks: MessageBlock[]): number {
  let total = 0
  for (const b of blocks) {
    if (b.type === 'text' || b.type === 'reasoning') total += estimateTokens(b.text)
    else total += estimateTokens(b.name + JSON.stringify(b.input) + (b.result ?? ''))
  }
  return total
}

export interface MicroCompactOptions {
  /** 模型上下文上限（tokens）；0 = 未知，不触发 */
  limit?: number
  /** 触发比例，默认 0.55 */
  ratio?: number
  /** 保留最近几条助手消息的结果，默认 2 */
  keepRecent?: number
}

export interface MicroCompactResult {
  messages: ChatHistoryMessage[]
  /** 被清理的结果条数 */
  cleared: number
  /** 节省的估算 token 数 */
  charsSaved: number
}

export function microCompactHistory(
  messages: ChatHistoryMessage[],
  opts: MicroCompactOptions = {},
): MicroCompactResult {
  const limit = opts.limit ?? 0
  const ratio = opts.ratio ?? MICRO_RATIO
  const keepRecent = opts.keepRecent ?? KEEP_RECENT_ASSISTANT
  if (!limit) return { messages, cleared: 0, charsSaved: 0 }

  const total = messages.reduce((sum, m) => sum + tokensOf(m.blocks), 0)
  if (total < limit * ratio) return { messages, cleared: 0, charsSaved: 0 }

  // 最近 keepRecent 条含工具调用的助手消息保留原样，更早的全部可清
  const toolAssistantIdx: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].blocks.some((b) => b.type === 'tool_use')) toolAssistantIdx.push(i)
    if (toolAssistantIdx.length >= keepRecent) break
  }
  const keepSet = new Set(toolAssistantIdx)

  let cleared = 0
  let charsSaved = 0
  const next = messages.map((m, mi) => {
    if (m.role !== 'assistant' || keepSet.has(mi)) return m
    let changed = false
    const blocks = m.blocks.map((b) => {
      if (b.type !== 'tool_use' || b.result == null || b.result.length < MIN_RESULT_CHARS) return b
      changed = true
      cleared++
      charsSaved += b.result.length
      return { ...b, result: `『工具结果已清理（原 ${b.result.length} 字符）：${headLine(b.result)}』` }
    })
    return changed ? { ...m, blocks } : m
  })
  return { messages: next, cleared, charsSaved }
}
