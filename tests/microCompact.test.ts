import { describe, expect, it } from 'vitest'
import type { ChatHistoryMessage, ToolUseBlock } from '../src/shared/types'
import { microCompactHistory } from '../src/main/microCompact'

function toolUse(id: string, result: string): ToolUseBlock {
  return { type: 'tool_use', id, name: 'read_file', input: { path: 'x' }, status: 'done', result }
}

function assistant(blocks: (ToolUseBlock | { type: 'text'; text: string })[]): ChatHistoryMessage {
  return { role: 'assistant', blocks }
}

function user(text: string): ChatHistoryMessage {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

const BIG = 'x'.repeat(2_000)
const SMALL = 'ok'

function fixture(): ChatHistoryMessage[] {
  return [
    user('问题'),
    assistant([toolUse('t1', BIG)]),
    user('继续'),
    assistant([toolUse('t2', BIG), { type: 'text', text: '中间结论' }]),
    user('再看'),
    assistant([toolUse('t3', BIG)]),
    assistant([toolUse('t4', SMALL)]),
  ]
}

describe('microCompact', () => {
  it('未达阈值不动', () => {
    const f = fixture()
    const r = microCompactHistory(f, { limit: 1_000_000 })
    expect(r.cleared).toBe(0)
    expect(r.messages).toBe(f) // 原数组原样返回（无复制）
  })

  it('limit 未知（0）不触发', () => {
    const r = microCompactHistory(fixture(), { limit: 0 })
    expect(r.cleared).toBe(0)
  })

  it('达阈值：早期工具结果清成占位符，最近 2 条助手消息保留', () => {
    const f = fixture()
    const r = microCompactHistory(f, { limit: 2_000 })
    expect(r.cleared).toBe(2) // t1、t2 被清；t3 在最近 2 条助手里；t4 太短
    const b1 = r.messages[1].blocks[0] as ToolUseBlock
    expect(b1.result).toContain('已清理')
    expect(b1.result).toContain(`原 ${BIG.length} 字符`)
    const b2 = r.messages[3].blocks[0] as ToolUseBlock
    expect(b2.result).toContain('已清理')
    const b3 = r.messages[5].blocks[0] as ToolUseBlock
    expect(b3.result).toBe(BIG) // 最近 2 条助手消息（t3/t4）原样保留
  })

  it('占位符幂等：二次清理不再产生变化', () => {
    const once = microCompactHistory(fixture(), { limit: 5_000 })
    const twice = microCompactHistory(once.messages, { limit: 5_000 })
    expect(twice.cleared).toBe(0)
  })

  it('短结果（<200 字符）不清理', () => {
    const f = [user('q'), assistant([toolUse('t', SMALL)])]
    const r = microCompactHistory(f, { limit: 1, keepRecent: 0 })
    expect(r.cleared).toBe(0)
  })

  it('文本块与用户消息不受影响', () => {
    const f = fixture()
    const r = microCompactHistory(f, { limit: 2_000 })
    expect(r.messages[0].blocks).toEqual([{ type: 'text', text: '问题' }])
    expect(r.messages[3].blocks[1]).toEqual({ type: 'text', text: '中间结论' })
  })
})
