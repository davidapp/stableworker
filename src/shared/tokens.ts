/**
 * 本地 token 估算（粗略）。
 * API 不返回逐段计数，只能估算上下文构成的"比例"；总量以服务端
 * usage.prompt_tokens 为准，估算值仅用于把总量拆分成几个部分。
 * 启发式：CJK 字符约 0.7 token/字，其他（ASCII）约 4 字符/token。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++
    else other++
  }
  return Math.round(cjk * 0.7 + other / 4)
}
