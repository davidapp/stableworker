import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterPaths, resolveMentions } from '../src/main/fileMentions'

describe('filterPaths 补全过滤', () => {
  const paths = ['src/main/llm.ts', 'src/App.tsx', 'README.md', 'tests/app.test.ts', 'docs/guide.md']

  it('文件名前缀命中优先于路径包含，长度短者优先', () => {
    expect(filterPaths(paths, 'app')).toEqual(['src/App.tsx', 'tests/app.test.ts'])
  })

  it('大小写不敏感；路径包含也能命中', () => {
    expect(filterPaths(paths, 'LLM')).toEqual(['src/main/llm.ts'])
    expect(filterPaths(paths, 'docs')).toEqual(['docs/guide.md'])
  })

  it('空片段返回前 30 条（按路径排序截断）', () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`)
    expect(filterPaths(many, '')).toHaveLength(30)
    expect(filterPaths(paths, '')).toEqual([...paths].sort((a, b) => a.length - b.length || a.localeCompare(b)))
  })
})

describe('resolveMentions 引用读取', () => {
  let root = ''

  it('读取/截断/缺失/越界', async () => {
    root = await mkdtemp(join(tmpdir(), 'sw-mention-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'console.log(1)')
    await writeFile(join(root, 'big.txt'), 'y'.repeat(30_000))
    await mkdir(join(root, 'sub'))

    const r = await resolveMentions(root, ['src/a.ts', 'big.txt', 'missing.md', '../outside.txt', 'sub'])
    expect(r[0]).toEqual({ path: 'src/a.ts', content: 'console.log(1)', missing: false, truncated: false })
    expect(r[1]?.content?.length).toBe(20_000)
    expect(r[1]?.truncated).toBe(true)
    expect(r[2]?.missing).toBe(true)
    expect(r[3]?.missing).toBe(true) // .. 越界被拒
    expect(r[4]?.missing).toBe(true) // 目录不可引用
  })

  it('总预算 60k：每个文件最多 20k，第 4 个文件耗尽预算只标记截断', async () => {
    for (const name of ['b1.txt', 'b2.txt', 'b3.txt', 'b4.txt']) {
      await writeFile(join(root, name), 'a'.repeat(50_000))
    }
    const r = await resolveMentions(root, ['b1.txt', 'b2.txt', 'b3.txt', 'b4.txt'])
    expect(r[0]?.content?.length).toBe(20_000)
    expect(r[0]?.truncated).toBe(true)
    expect(r[1]?.content?.length).toBe(20_000)
    expect(r[2]?.content?.length).toBe(20_000)
    expect(r[3]?.content).toBeNull()
    expect(r[3]?.truncated).toBe(true)
  })

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })
})
