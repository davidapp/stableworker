import type { ChatHistoryMessage } from './types'

/**
 * 本地 token 估算（粗略）。
 * API 不返回逐段计数，只能估算上下文构成的"比例"；总量以服务端
 * usage.prompt_tokens 为准，估算值仅用于把总量拆分成几个部分。
 * 启发式：CJK 字符约 0.7 token/字，其他（ASCII）约 4 字符/token。
 */

/** CJK 区间（与旧正则等价）：汉字 / CJK 标点 / 全角形式 */
function isCjk(c: number): boolean {
  return (
    (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)
  )
}

export function estimateTokens(text: string): number {
  const n = text.length
  if (!n) return 0
  let cjk = 0
  // 按 charCodeAt 紧凑扫描（旧实现逐字符跑正则 test，MB 级文本是热路径瓶颈）
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i)
    if (isCjk(c)) cjk++
    else if (c >= 0xd800 && c < 0xdc00) i++ // 高代理：与低代理合占一个字符位
  }
  return Math.round(cjk * 0.7 + (n - cjk) / 4)
}

/**
 * 按块对象缓存的整条消息 token 估算（不含消息封套开销）。
 * 消息/块遵循不可变更新，唯一例外是主循环工具执行会原地改写 tool_use 块的
 * result / input（llm.ts 的 tu.result = … / tu.input = …），故缓存条目以
 * input 引用 + result 长度为失效哨兵，突变后自动重算。
 * 每轮请求的裁剪/压缩/面板估算因此只需对新消息付费，不再全量重扫历史。
 */
interface BlockCacheEntry {
  tokens: number
  resultLen: number
  input: unknown
}
const blockTokensCache = new WeakMap<object, BlockCacheEntry>()

export function estimateMessageTokensCached(m: ChatHistoryMessage): number {
  let total = 0
  for (const b of m.blocks) {
    if (b.type === 'text' || b.type === 'reasoning') {
      total += estimateTokens(b.text) // 文本/思考块从不原地改写，无需缓存
      continue
    }
    // tool_use 块：缓存以 input 引用 + result 长度为失效哨兵（主循环会原地改写这两个字段）
    const resultLen = b.result?.length ?? -1
    const cached = blockTokensCache.get(b)
    if (cached && cached.resultLen === resultLen && cached.input === b.input) {
      total += cached.tokens
      continue
    }
    const tokens = estimateTokens(b.name + JSON.stringify(b.input) + (b.result ?? ''))
    blockTokensCache.set(b, { tokens, resultLen, input: b.input })
    total += tokens
  }
  return total
}
