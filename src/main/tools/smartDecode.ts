/**
 * Windows 控制台输出智能解码：cmd 默认代码页（如 GBK/936）的中文经 UTF-8
 * 解码会出现 U+FFFD 替换符。启发式：UTF-8 解码结果中替换符越多越不可信，
 * 此时改用 GBK 解码，取替换符更少的结果。
 */
export function smartDecode(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gbk = new TextDecoder('gbk').decode(buf)
    const bad = (s: string): number => (s.match(/\uFFFD/g) || []).length
    return bad(gbk) < bad(utf8) ? gbk : utf8
  } catch {
    return utf8
  }
}
