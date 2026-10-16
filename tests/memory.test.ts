import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgentsMd, loadMemoryLayers } from '../src/main/agentsMd'
import { memoryDirFor, memoryTool } from '../src/main/memoryDir'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sw-memory-'))
  // memory 工具的存储根指向测试临时目录（memoryDir 按调用时读取该环境变量）
  process.env.SW_MEMORY_TEST_ROOT = join(root, 'memroot')
  // 全局层
  await mkdir(join(root, 'global'), { recursive: true })
  await writeFile(join(root, 'global', 'AGENTS.md'), '全局：用中文回复')
  // 父目录层
  await mkdir(join(root, 'repo'), { recursive: true })
  await writeFile(join(root, 'repo', 'AGENTS.md'), '父目录：monorepo 使用 pnpm')
  // 项目层（带 @引用）
  await mkdir(join(root, 'repo', 'app'), { recursive: true })
  await writeFile(join(root, 'repo', 'app', 'AGENTS.md'), '@../team-style.md\n项目：React 19')
  await writeFile(join(root, 'repo', 'team-style.md'), '团队：缩进 2 空格')
  // 项目本地层
  await writeFile(join(root, 'repo', 'app', 'AGENTS.local.md'), '本地：实验分支可放宽')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('分层记忆加载', () => {
  it('按 全局 → 父目录 → 项目 → 项目本地 顺序拼接，近处在后', async () => {
    const text = await loadAgentsMd(join(root, 'repo', 'app'), join(root, 'global'))
    const gi = text.indexOf('全局：用中文回复')
    const pi = text.indexOf('父目录：monorepo')
    const ti = text.indexOf('团队：缩进 2 空格')
    const xi = text.indexOf('项目：React 19')
    const li = text.indexOf('本地：实验分支可放宽')
    expect(gi).toBeGreaterThanOrEqual(0)
    expect(gi < pi).toBe(true)
    expect(pi < ti).toBe(true)
    expect(ti < xi).toBe(true)
    expect(xi < li).toBe(true)
  })

  it('@相对路径 引用被展开（相对所在文件目录，支持嵌套）', async () => {
    const text = await loadAgentsMd(join(root, 'repo', 'app'), join(root, 'global'))
    expect(text).toContain('团队：缩进 2 空格')
    expect(text).toContain('引用自 @../team-style.md')
  })

  it('loadMemoryLayers 列出全部层与原文', async () => {
    const layers = await loadMemoryLayers(join(root, 'repo', 'app'), join(root, 'global'))
    const labels = layers.map((l) => l.label)
    expect(labels).toContain('全局')
    expect(labels).toContain('项目')
    expect(labels).toContain('项目本地')
    const project = layers.find((l) => l.label === '项目')
    expect(project?.raw).toContain('React 19')
  })

  it('没有任何层时返回空串', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'sw-mem-empty-'))
    try {
      expect(await loadAgentsMd(join(empty, 'proj'), join(empty, 'g'))).toBe('')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('memory 工具', () => {
  const projectA = join(root, 'repo', 'app')

  it('write → read → list → delete 往返', async () => {
    const w = await memoryTool.execute({ action: 'write', path: 'notes.md', content: '用户偏好：简洁回复' }, { projectPath: projectA })
    expect(w.content).toContain('notes.md')
    const r = await memoryTool.execute({ action: 'read', path: 'notes.md' }, { projectPath: projectA })
    expect(r.content).toBe('用户偏好：简洁回复')
    const l = await memoryTool.execute({ action: 'list' }, { projectPath: projectA })
    expect(l.content).toContain('notes.md')
    const d = await memoryTool.execute({ action: 'delete', path: 'notes.md' }, { projectPath: projectA })
    expect(d.content).toContain('已删除')
    expect(await readFile(join(memoryDirFor(projectA), 'notes.md'), 'utf-8').catch(() => null)).toBeNull()
  })

  it('拒绝越界路径（.. 与绝对路径）', async () => {
    const up = await memoryTool.execute({ action: 'write', path: '../escape.md', content: 'x' }, { projectPath: projectA })
    expect(up.isError).toBe(true)
    const abs = await memoryTool.execute({ action: 'write', path: join(root, 'escape.md'), content: 'x' }, { projectPath: projectA })
    expect(abs.isError).toBe(true)
  })

  it('不同项目目录隔离；默认操作落在 MEMORY.md', async () => {
    await memoryTool.execute({ action: 'write', content: 'A 项目记忆' }, { projectPath: projectA })
    const other = await memoryTool.execute({ action: 'read' }, { projectPath: join(root, 'other') })
    expect(other.content).not.toContain('A 项目记忆')
    const same = await memoryTool.execute({ action: 'read' }, { projectPath: projectA })
    expect(same.content).toBe('A 项目记忆')
  })
})
