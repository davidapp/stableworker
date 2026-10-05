import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadAgentsMd } from '../src/main/agentsMd'

let dir: string
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('loadAgentsMd', () => {
  it('没有 AGENTS.md 返回空串', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sw-agents-'))
    expect(await loadAgentsMd(dir)).toBe('')
  })

  it('读取内容并 trim', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '\n  本项目使用 TypeScript，测试用 vitest。 \n')
    expect(await loadAgentsMd(dir)).toBe('本项目使用 TypeScript，测试用 vitest。')
  })

  it('空文件返回空串', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '   \n  ')
    expect(await loadAgentsMd(dir)).toBe('')
  })

  it('超长内容截断并注明', async () => {
    const long = 'x'.repeat(25_000)
    await writeFile(join(dir, 'AGENTS.md'), long)
    const out = await loadAgentsMd(dir)
    expect(out).toHaveLength(20_000 + '\n…（AGENTS.md 过长，已截断）'.length)
    expect(out.endsWith('已截断）')).toBe(true)
  })

  it('路径不存在时返回空串（读取失败被吞掉）', async () => {
    expect(await loadAgentsMd(join(dir, 'no-such-subdir'))).toBe('')
  })
})
