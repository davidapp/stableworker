import { describe, expect, it } from 'vitest'
import { diffLines } from '../src/shared/diff'

describe('diffLines 行级 LCS diff', () => {
  it('识别替换行（del + add + 上下文）', () => {
    const d = diffLines('a\nb\nc', 'a\nx\nc')
    expect(d).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'ctx', text: 'c' },
    ])
  })

  it('空旧文本 → 先删空行再全部新增', () => {
    // 空字符串按一行空行处理（split('\n') 语义），因此先 del 空行
    const d = diffLines('', 'a\nb')
    expect(d).toEqual([
      { type: 'del', text: '' },
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ])
  })

  it('完全相同的文本 → 全部上下文', () => {
    const d = diffLines('a\nb', 'a\nb')
    expect(d.every((l) => l.type === 'ctx')).toBe(true)
    expect(d).toHaveLength(2)
  })

  it('尾部新增', () => {
    const d = diffLines('a', 'a\nb')
    expect(d).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'add', text: 'b' },
    ])
  })

  it('超大文本降级为整删整加（不崩溃）', () => {
    const old = Array.from({ length: 1000 }, (_, i) => `old-${i}`).join('\n')
    const neo = Array.from({ length: 1000 }, (_, i) => `new-${i}`).join('\n')
    const d = diffLines(old, neo)
    expect(d.filter((l) => l.type === 'del')).toHaveLength(1000)
    expect(d.filter((l) => l.type === 'add')).toHaveLength(1000)
  })
})
