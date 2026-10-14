/**
 * WebFetch：抓取 URL 内容转成 markdown 风格文本给模型。
 * - 15 分钟内存缓存（同一 URL 重复抓取零成本）
 * - SSRF 防护：只允许 http/https，拒绝内网地址（localhost / 私有网段 / 链路本地）
 * - 输出截断到 2 万字符（HTML 转文本的轻量转换，非完整 markdown 渲染）
 */

import type { ToolContext } from './index'

const MAX_CHARS = 20_000
const CACHE_TTL = 15 * 60_000

const cache = new Map<string, { content: string; at: number }>()

/** SSRF 防护：拒绝非 http(s) 协议与内网 / 本地地址 */
function assertPublicUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`URL 无效：${raw}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`仅支持 http/https 协议（收到 ${u.protocol}）`)
  }
  const h = u.hostname.toLowerCase()
  const blocked =
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === '::1' ||
    h === '[::1]'
  if (blocked) throw new Error(`拒绝访问内网地址：${h}`)
  return u
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

/** 轻量 HTML → 可读文本（标题/列表/链接/换行的基本转换） */
function htmlToText(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag: string, t: string) => `\n\n${'#'.repeat(Number(tag[1]))} ${stripTags(t)}\n`)
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t: string) => `\n- ${stripTags(t)}`)
      .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => `[${stripTags(t)}](${href})`)
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<(p|div|section|article|ul|ol|table|tr|pre)[^>]*>/gi, '\n')
      .replace(/<\/(p|div|section|article|ul|ol|table|tr|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

export const webFetchTool = {
  name: 'web_fetch',
  description:
    '抓取一个 http/https 网页，把内容转成文本返回（15 分钟缓存）。用于查阅在线文档、博客、开源仓库页面等。内网地址会被拒绝。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的完整 URL（http/https）' },
    },
    required: ['url'],
  },
  kind: 'read' as const,
  timeoutMs: 30_000,
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    const url = typeof input.url === 'string' ? input.url : ''
    if (!url) return { content: '缺少 url 参数', isError: true }

    let u: URL
    try {
      u = assertPublicUrl(url)
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true }
    }

    const hit = cache.get(u.href)
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      return { content: `${hit.content}\n\n（来自 15 分钟缓存）` }
    }

    let res: Response
    try {
      res = await fetch(u.href, { signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
    } catch (e) {
      return { content: `抓取失败：${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
    if (!res.ok) return { content: `HTTP ${res.status} ${res.statusText}`, isError: true }

    const html = await res.text()
    const isHtml = /<html|<body|<div/i.test(html)
    const content = isHtml ? htmlToText(html) : html
    const final = content.length > MAX_CHARS ? `${content.slice(0, MAX_CHARS)}\n…（已截断到 ${MAX_CHARS} 字符）` : content
    cache.set(u.href, { content: final, at: Date.now() })
    return { content: final }
  },
}
