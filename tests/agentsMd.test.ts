import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadAgentsMd } from '../src/main/agentsMd'

let dir: string
let globalDir: string
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('loadAgentsMd', () => {
  it('没有 AGENTS.md 返回空串', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sw-agents-'))
    globalDir = await mkdtemp(join(tmpdir(), 'sw-agents-g-'))
    expect(await loadAgentsMd(dir, globalDir)).toBe('')
  })

  it('项目层内容注入（带层头，内容 trim）', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '\n  本项目使用 TypeScript，测试用 vitest。 \n')
    const out = await loadAgentsMd(dir, globalDir)
    expect(out).toContain('本项目使用 TypeScript，测试用 vitest。')
    expect(out).toContain('【记忆层：项目')
  })

  it('空文件返回空串', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '   \n  ')
    expect(await loadAgentsMd(dir, globalDir)).toBe('')
  })

  it('超长内容截断并注明', async () => {
    const long = 'x'.repeat(25_000)
    await writeFile(join(dir, 'AGENTS.md'), long)
    const out = await loadAgentsMd(dir, globalDir)
    expect(out.endsWith('已截断）')).toBe(true)
    expect(out.length).toBeLessThan(long.length)
  })

  it('路径不存在时返回空串（读取失败被吞掉）', async () => {
    // 全新目录树：项目目录与各祖先层都不存在
    const fresh = await mkdtemp(join(tmpdir(), 'sw-agents-missing-'))
    try {
      expect(await loadAgentsMd(join(fresh, 'no-such-subdir'), join(fresh, 'g'))).toBe('')
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })
})
