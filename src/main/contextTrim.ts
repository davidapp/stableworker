import { estimateTokens } from '../shared/tokens'
import type { ChatHistoryMessage, MessageBlock } from '../shared/types'

/**
 * 发送前历史裁剪（台阶 4b）：
 * 当估算的历史大小超过预算时，从最旧的整组对话开始丢弃，只影响发给模型的
 * 请求体——会话文件与聊天界面里的历史保持完整。
 *
 * 不变量（踩坑换来的）：
 * - 按整组（用户消息 + 其后的助手回复）裁剪，绝不把 tool_calls 和它的
 *   tool_result 拆开，否则会被服务端以 400 拒绝
 * - 至少保留最后一组（刚发出的用户消息必须在场）
 * - 估算用本地启发式（shared/tokens），因此预算系数取得保守（0.7）
 */

/** 单条消息的 token 估算：所有块的文本 + 工具参数 JSON + 工具结果 + 消息封套开销 */
export function estimateMessageTokens(m: ChatHistoryMessage): number {
  const sum = (blocks: MessageBlock[]): number =>
    blocks.reduce((acc, b) => {
      if (b.type === 'text' || b.type === 'reasoning') return acc + estimateTokens(b.text)
      // 工具调用：名字 + 参数 JSON + 结果文本
      return (
        acc +
        estimateTokens(b.name) +
        estimateTokens(JSON.stringify(b.input)) +
        estimateTokens(b.result ?? '')
      )
    }, 0)
  return sum(m.blocks) + 16 // role/封套等固定开销
}

export interface TrimResult {
  kept: ChatHistoryMessage[]
  /** 被裁掉的消息条数 */
  trimmedCount: number
  /** 是否发生了裁剪 */
  trimmed: boolean
}

/**
 * 超预算时从最旧的整组开始丢弃。
 * tokenBudget 是"消息历史"可用的 token 数（总预算扣除系统提示词/工具定义/输出预留）。
 */
export function trimHistory(history: ChatHistoryMessage[], tokenBudget: number): TrimResult {
  if (history.length === 0) return { kept: history, trimmedCount: 0, trimmed: false }

  // 组边界：用户消息且（是第一条 或 前一条是助手）→ 每组 = 该用户消息 + 其后的所有助手消息
  const groupStarts: number[] = []
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user' && (i === 0 || history[i - 1].role === 'assistant')) {
      groupStarts.push(i)
    }
  }
  // 没有用户消息开头的组（异常形态）就不裁，保守处理
  if (groupStarts.length === 0) return { kept: history, trimmedCount: 0, trimmed: false }

  // 从每个可能的保留起点计算后缀总量
  const suffix = new Array<number>(history.length + 1).fill(0)
  for (let i = history.length - 1; i >= 0; i--) {
    suffix[i] = suffix[i + 1] + estimateMessageTokens(history[i])
  }

  // 找最小的组起点 g，使得从 g 保留到末尾的估算总量 <= 预算；
  // 同时强制至少保留最后一组（最后一组的起点永远可选）
  let best = groupStarts[groupStarts.length - 1]
  for (const g of groupStarts) {
    if (suffix[g] <= tokenBudget) {
      best = g
      break
    }
  }

  const kept = history.slice(best)
  return {
    kept,
    trimmedCount: history.length - kept.length,
    trimmed: best > 0,
  }
}
