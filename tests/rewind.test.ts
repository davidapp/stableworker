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

import { buildForkSession } from '../src/main/sessions'
import type { Session } from '../src/shared/types'

describe('buildForkSession 会话分叉', () => {
  const session: Session = {
    id: 's1',
    title: '调试登录问题',
    createdAt: 1,
    updatedAt: 2,
    projectId: 'p1',
    summary: { droppedCount: 5, text: '旧摘要', ts: 3 },
    messages: [
      msg('u1', 'user'),
      msg('a1', 'assistant', [
        { type: 'text', text: 'x' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: {}, status: 'done' },
      ]),
      msg('u2', 'user'),
    ],
  }

  it('复制目标及之前为全新会话：标题加后缀、摘要不继承、深拷贝', () => {
    const r = buildForkSession(session, 'u2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const forked = r.session
    expect(forked.id).not.toBe('s1')
    expect(forked.title).toBe('调试登录问题 · 分叉')
    expect(forked.messages).toHaveLength(3)
    expect(forked.summary).toBeUndefined()
    expect(forked.createdAt).toBe(forked.updatedAt)
    // 深拷贝：改分叉不影响原会话
    forked.messages[0].blocks[0] = { type: 'text', text: 'mutated' }
    expect(session.messages[0].blocks[0]).toMatchObject({ text: 'u1' })
  })

  it('从最后一条分叉 = 完整复制；消息不存在报错', () => {
    const full = buildForkSession(session, 'u2')
    expect(full.ok && full.session.messages).toHaveLength(3)
    expect(buildForkSession(session, 'nope')).toEqual({ ok: false, error: '消息不存在（可能已被删除）' })
  })
})
