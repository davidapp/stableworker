import { loadConfig, decryptApiKey } from '../config'
import type { ToolContext, ToolDefinition } from './index'

/**
 * WebSearch（对齐 Claude Code 的 WebSearch）：DeepSeek Search API。
 * POST {base}/v1/tools/search，与聊天共用同一个 DeepSeek API Key。
 * 按当前激活配置档匹配 DeepSeek 凭据（baseURL 含 deepseek），找不到时明确报错。
 * 返回排序后的标题 / 链接 / 摘要，总量截断防失控。
 */

const SEARCH_ENDPOINT = '/v1/tools/search'
const MAX_QUERY_CHARS = 128
const MAX_TOTAL_CHARS = 15_000

export interface SearchHit {
  title: string
  url: string
  snippet: string
  rerankScore: number
  authority: number
  date: string | null
  siteName: string | null
}

/** 校验并规范化查询词（1–128 字符、非全空白，DeepSeek 的硬性要求） */
export function validateSearchQuery(query: string): { ok: true; query: string } | { ok: false; error: string } {
  const q = query.trim()
  if (!q) return { ok: false, error: 'query 不能为空' }
  if ([...q].length > MAX_QUERY_CHARS) return { ok: false, error: `query 过长（最多 ${MAX_QUERY_CHARS} 字符）` }
  return { ok: true, query: q }
}

/** 结果格式化为模型可读文本（保持 API 返回顺序；总量截断） */
export function formatSearchResults(hits: SearchHit[], budget = MAX_TOTAL_CHARS): string {
  if (hits.length === 0) return '（没有搜索结果）'
  const lines: string[] = []
  let used = 0
  hits.forEach((h, i) => {
    if (used >= budget) return
    const meta = [h.siteName, h.date ? h.date.slice(0, 10) : null, `权威性 ${h.authority}/4`].filter(Boolean)
    const block = [`[${i + 1}] ${h.title}`, h.url, meta.length ? `(${meta.join(' · ')})` : '', h.snippet]
    for (const line of block) {
      if (used + line.length > budget) {
        used = budget
        break
      }
      lines.push(line)
      used += line.length
    }
    lines.push('')
    used += 2
  })
  return lines.join('\n').trim()
}

function findDeepSeekProfile(profiles: Array<{ id: string; baseURL: string; apiKey: string; isActive: boolean }>): { baseURL: string; apiKey: string } | null {
  const active = profiles.find((p) => p.isActive && /deepseek/i.test(p.baseURL))
  const any = profiles.find((p) => /deepseek/i.test(p.baseURL))
  return active ?? any ?? null
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    '联网搜索（DeepSeek Search API，使用当前 DeepSeek 配置的 API Key）。' +
    '返回排序后的网页标题 / 链接 / 摘要。适合查最新资料、官方文档、报错方案；' +
    '支持 site: 限定域名、-site: 排除、引号精确匹配。需要网页正文时配合 web_fetch 使用。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索词（1–128 字符；支持 site: / -site: / 引号语法）' },
      count: { type: 'number', description: '返回条数（1–50，默认 8）' },
    },
    required: ['query'],
  },
  kind: 'read',
  timeoutMs: 30_000,
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    const v = validateSearchQuery(typeof input.query === 'string' ? input.query : '')
    if (!v.ok) return { content: v.error, isError: true }
    const count = Math.min(50, Math.max(1, typeof input.count === 'number' && Number.isFinite(input.count) ? Math.round(input.count) : 8))

    const cfg = await loadConfig()
    const profiles = (cfg.llmProfiles ?? []).map((p) => ({
      id: p.id,
      baseURL: p.baseURL,
      apiKey: decryptApiKey(p.apiKey),
      isActive: p.id === cfg.activeLlmId,
    }))
    const source = findDeepSeekProfile(profiles)
    if (!source || !source.apiKey) {
      return {
        content: '未找到可用的 DeepSeek 配置：web_search 使用 DeepSeek Search API，需要一个 baseURL 含 deepseek 且已填 API Key 的配置档。',
        isError: true,
      }
    }

    const base = source.baseURL.trim().replace(/\/+$/, '') || 'https://api.deepseek.com'
    const timeout = AbortSignal.timeout(30_000)
    try {
      const res = await fetch(base + SEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${source.apiKey}`,
        },
        body: JSON.stringify({ query: v.query, count }),
        signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
      })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300)
        return { content: `搜索失败：HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`, isError: true }
      }
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> }
      const hits: SearchHit[] = (data.results ?? []).map((r) => ({
        title: String(r.title ?? ''),
        url: String(r.url ?? ''),
        snippet: String(r.snippet ?? ''),
        rerankScore: typeof r.rerank_score === 'number' ? r.rerank_score : 0,
        authority: typeof r.authority === 'number' ? r.authority : -1,
        date: typeof r.date === 'string' ? r.date : null,
        siteName: typeof r.site_name === 'string' ? r.site_name : null,
      }))
      return { content: formatSearchResults(hits) }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { content: `搜索失败：${msg}${/abort/i.test(msg) ? '（超时或被中止）' : ''}`, isError: true }
    }
  },
}
