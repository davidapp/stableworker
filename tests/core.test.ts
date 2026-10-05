import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../src/shared/tokens'
import { globToRegExp } from '../src/main/tools/search'
import { trimHistory } from '../src/main/contextTrim'
import type { ChatHistoryMessage } from '../src/shared/types'

describe('estimateTokens 本地估算', () => {
  it('CJK 字符权重高于 ASCII', () => {
    const cjk = estimateTokens('你好世界')
    const ascii = estimateTokens('abcd')
    expect(cjk).toBeGreaterThan(ascii)
  })

  it('空文本为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('globToRegExp', () => {
  const t = (glob: string, path: string): boolean => globToRegExp(glob).test(path)

  it('段内 * 不跨目录', () => {
    expect(t('*.ts', 'a.ts')).toBe(true)
    expect(t('*.ts', 'src/a.ts')).toBe(false)
  })

  it('** 跨目录（可匹配零层）', () => {
    expect(t('src/**/*.ts', 'src/main/llm.ts')).toBe(true)
    expect(t('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(t('src/**/*.ts', 'lib/a.ts')).toBe(false)
  })

  it('? 恰好一个字符', () => {
    expect(t('test?.py', 'test1.py')).toBe(true)
    expect(t('test?.py', 'test12.py')).toBe(false)
  })

  it('正则特殊字符按字面量处理', () => {
    expect(t('a+b.ts', 'a+b.ts')).toBe(true)
    expect(t('a+b.ts', 'aab.ts')).toBe(false)
  })
})

const msg = (role: 'user' | 'assistant', text: string): ChatHistoryMessage => ({
  role,
  blocks: [{ type: 'text', text }],
})

describe('trimHistory 整组裁剪', () => {
  // 5 组对话，每组 2 条
  const history = Array.from({ length: 5 }, () => [msg('user', 'u'.repeat(400)), msg('assistant', 'a'.repeat(400))]).flat()

  it('预算不足时从最旧的整组丢弃，边界落在用户消息上', () => {
    const r = trimHistory(history, 400)
    expect(r.trimmed).toBe(true)
    expect(r.trimmedCount).toBe(8)
    expect(r.kept).toHaveLength(2)
    expect(r.kept[0].role).toBe('user')
  })

  it('预算充足不裁剪', () => {
    expect(trimHistory(history, 100000).trimmed).toBe(false)
  })

  it('预算极小也至少保留最后一组', () => {
    const r = trimHistory(history, 10)
    expect(r.kept).toHaveLength(2)
    expect(r.kept[0].role).toBe('user')
  })
})
