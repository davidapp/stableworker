import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import { planRewind } from '../src/main/sessions'

function msg(id: string, role: 'user' | 'assistant', blocks: ChatMessage['blocks'] = [{ type: 'text', text: id }]): ChatMessage {
  return { id, role, blocks, createdAt: 0 }
}

describe('planRewind 回退计划', () => {
  it('保留目标及之前，收集被删范围的工具调用（时间顺序）', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', [
        { type: 'text', text: 'x' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: {}, status: 'done' },
      ]),
      msg('u2', 'user'),
      msg('a2', 'assistant', [{ type: 'tool_use', id: 't2', name: 'write_file', input: { path: 'a' }, status: 'done' }]),
    ]
    expect(planRewind(messages, 'u2')).toEqual({
      ok: true,
      keepCount: 3,
      removedCount: 1,
      removedToolUseIds: ['t2'],
    })
  })

  it('消息不存在报错；目标为最后一条时无回退空间', () => {
    const messages = [msg('u1', 'user'), msg('a1', 'assistant')]
    expect(planRewind(messages, 'nope')).toEqual({ ok: false, error: '消息不存在（可能已被删除）' })
    const p = planRewind(messages, 'a1')
    expect(p.ok).toBe(true)
    if (p.ok) expect(p.removedCount).toBe(0)
  })
})
