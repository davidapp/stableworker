import { describe, expect, it } from 'vitest'
import {
  buildSummaryUserPrompt,
  mergeSummaryIntoFirstUser,
  parseSummaryResponse,
  serializeTranscript,
  worthSummarizing,
} from '../src/main/compact'
import type { ChatHistoryMessage } from '../src/shared/types'

const msg = (role: 'user' | 'assistant', text: string): ChatHistoryMessage => ({
  role,
  blocks: [{ type: 'text', text }],
})

describe('serializeTranscript', () => {
  it('文本块带角色前缀', () => {
    const s = serializeTranscript([msg('user', '你好'), msg('assistant', '你好呀')])
    expect(s).toContain('用户: 你好')
    expect(s).toContain('助手: 你好呀')
  })

  it('工具调用记名称与参数，结果截断', () => {
    const m: ChatHistoryMessage = {
      role: 'assistant',
      blocks: [
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' }, status: 'done', result: '文件内容' },
      ],
    }
    const s = serializeTranscript([m])
    expect(s).toContain('[调用工具 read_file')
    expect(s).toContain('[工具结果] 文件内容')
  })
})

describe('buildSummaryUserPrompt', () => {
  it('包含结构化要求与对话历史', () => {
    const p = buildSummaryUserPrompt('用户: 做个网站')
    expect(p).toContain('用户的原始目标')
    expect(p).toContain('=== 对话历史开始 ===')
    expect(p).toContain('用户: 做个网站')
  })
})

describe('mergeSummaryIntoFirstUser', () => {
  it('合并进第一条用户消息的块首', () => {
    const merged = mergeSummaryIntoFirstUser([msg('user', '继续'), msg('assistant', '好')], '早期做过 X')
    expect(merged).toHaveLength(2)
    expect(merged[0].role).toBe('user')
    expect(merged[0].blocks[0]).toEqual({ type: 'text', text: '[早期对话摘要（自动压缩，供参考）]\n早期做过 X' })
    expect(merged[0].blocks[1]).toEqual({ type: 'text', text: '继续' })
  })

  it('首条是助手消息时插入合成用户消息', () => {
    const merged = mergeSummaryIntoFirstUser([msg('assistant', '在的')], '摘要')
    expect(merged).toHaveLength(2)
    expect(merged[0].role).toBe('user')
  })

  it('空消息列表返回单条摘要用户消息', () => {
    const merged = mergeSummaryIntoFirstUser([] as ChatHistoryMessage[], '摘要')
    expect(merged).toHaveLength(1)
    expect(merged[0].role).toBe('user')
  })
})

describe('parseSummaryResponse', () => {
  it('OpenAI 格式取 choices[0].message.content', () => {
    expect(
      parseSummaryResponse('openai-compatible', { choices: [{ message: { content: '摘要内容' } }] }),
    ).toBe('摘要内容')
  })

  it('Anthropic 格式拼接 content 数组的 text 块', () => {
    expect(
      parseSummaryResponse('anthropic', { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }),
    ).toBe('AB')
  })
})

describe('worthSummarizing', () => {
  it('少于 2 条不值得', () => {
    expect(worthSummarizing([msg('user', 'x'.repeat(5000))])).toBe(false)
  })

  it('内容太少不值得（≤300 tokens）', () => {
    expect(worthSummarizing([msg('user', 'hi'), msg('assistant', 'ok')])).toBe(false)
  })

  it('足够内容值得摘要', () => {
    expect(worthSummarizing([msg('user', 'u'.repeat(2000)), msg('assistant', 'a'.repeat(2000))])).toBe(true)
  })
})
