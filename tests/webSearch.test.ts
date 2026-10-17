import { describe, expect, it } from 'vitest'
import { formatSearchResults, validateSearchQuery, type SearchHit } from '../src/main/tools/webSearch'

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  title: 'DeepSeek Search API 文档',
  url: 'https://api-docs.deepseek.com/search',
  snippet: '网页搜索接口说明',
  rerankScore: 2.1,
  authority: 3,
  date: '2026-10-16T00:00:00Z',
  siteName: 'DeepSeek',
  ...over,
})

describe('validateSearchQuery 校验', () => {
  it('空白/超长拒绝，正常裁剪空白', () => {
    expect(validateSearchQuery('   ').ok).toBe(false)
    expect(validateSearchQuery('x'.repeat(129)).ok).toBe(false)
    const r = validateSearchQuery('  deepseek search api  ')
    expect(r.ok && r.query).toBe('deepseek search api')
  })
})

describe('formatSearchResults 格式化', () => {
  it('编号 + 标题 + URL + 元信息 + 摘要', () => {
    const out = formatSearchResults([hit()])
    expect(out).toContain('[1] DeepSeek Search API 文档')
    expect(out).toContain('https://api-docs.deepseek.com/search')
    expect(out).toContain('DeepSeek · 2026-10-16 · 权威性 3/4')
    expect(out).toContain('网页搜索接口说明')
  })

  it('空结果提示；预算截断不再追加', () => {
    expect(formatSearchResults([])).toBe('（没有搜索结果）')
    const long = 'y'.repeat(20_000)
    const out = formatSearchResults([hit({ snippet: long }), hit({ title: '第二条' })], 5_000)
    expect(out).not.toContain('第二条') // 预算耗尽，后面的结果不输出
  })
})
