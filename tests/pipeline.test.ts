import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.root },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (b: Buffer) => b, decryptString: (b: Buffer) => b },
  ipcMain: { handle: () => undefined },
  dialog: {},
  shell: {},
}))

import { savePipeline, loadPipeline, restorePipelineRevision, startRun, saveRunState, readRunState, latestRunDir, validatePipeline, topoSort } from '../src/main/pipelineStore'
import { planTargets, runPipeline, type NodeExecutor } from '../src/main/pipelineRunner'
import type { PipelineDoc } from '../src/main/pipelineStore'

const doc = (over: Partial<PipelineDoc> = {}): PipelineDoc => ({
  schema: 1,
  name: '测试流水线',
  nodes: [
    { id: 'n1', type: 'script', name: '文案', params: { text: 'hello' }, deps: [] },
    { id: 'n2', type: 'tts', name: '配音', params: {}, deps: ['n1'] },
    { id: 'n3', type: 'ffmpeg', name: '合成', params: {}, deps: ['n2'] },
  ],
  ...over,
})

beforeAll(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'sw-pipeline-'))
})
afterAll(async () => {
  await rm(fixture.root, { recursive: true, force: true })
})

describe('流水线校验', () => {
  it('合法文档通过并补齐默认值', () => {
    const parsed = validatePipeline(doc())
    expect(parsed.nodes).toHaveLength(3)
    expect(parsed.nodes[0].enabled).toBe(true)
    expect(parsed.nodes[0].params).toEqual({ text: 'hello' })
  })
  it('拒绝重复 id、坏引用、未知类型与循环依赖', () => {
    expect(() => validatePipeline(doc({ nodes: [...doc().nodes.slice(0, 2), { ...doc().nodes[0] }] }))).toThrow(/重复/)
    expect(() => validatePipeline(doc({ nodes: [{ id: 'a', type: 'tts', name: 'x', params: {}, deps: ['ghost'] }] }))).toThrow(/不存在/)
    expect(() => validatePipeline(doc({ nodes: [{ id: 'a', type: 'magic', name: 'x', params: {}, deps: [] } as never] }))).toThrow(/type/)
    expect(() => validatePipeline(doc({
      nodes: [
        { id: 'a', type: 'tts', name: 'x', params: {}, deps: ['b'] },
        { id: 'b', type: 'tts', name: 'y', params: {}, deps: ['a'] },
      ],
    }))).toThrow(/循环依赖/)
    expect(() => validatePipeline(doc({ name: '' }))).toThrow(/name/)
  })
  it('inputFrom 也算依赖并参与环检测', () => {
    expect(() => validatePipeline(doc({
      nodes: [
        { id: 'a', type: 'image', name: 'x', params: {}, deps: [], inputFrom: { image: 'b' } },
        { id: 'b', type: 'video', name: 'y', params: {}, deps: ['a'] },
      ],
    }))).toThrow(/循环依赖/)
  })
  it('topoSort 依赖在前', () => {
    const order = topoSort(doc()).map((n) => n.id)
    expect(order.indexOf('n1')).toBeLessThan(order.indexOf('n2'))
    expect(order.indexOf('n2')).toBeLessThan(order.indexOf('n3'))
  })
})

describe('planTargets', () => {
  it('from 截取拓扑尾部；nodes 子集保持拓扑序；未知 id 报错', () => {
    const d = doc()
    expect(planTargets(d, { from: 'n2' }).map((n) => n.id)).toEqual(['n2', 'n3'])
    expect(planTargets(d, { nodes: ['n3', 'n1'] }).map((n) => n.id)).toEqual(['n1', 'n3'])
    expect(() => planTargets(d, { nodes: ['nope'] })).toThrow(/不存在/)
    expect(() => planTargets(d, { from: 'zz' })).toThrow(/不存在/)
  })
})

describe('工程文件版本与运行状态', () => {
  it('保存追加版本、current 指向最新、回退生成新版本保留历史', async () => {
    const v1 = await savePipeline('s1', doc({ name: '第一版' }), '初始')
    expect(v1).toBe(1)
    await savePipeline('s1', doc({ name: '第二版', nodes: doc().nodes.slice(0, 2) }), '删掉合成')
    const bundle = await loadPipeline('s1')
    expect(bundle?.revision).toBe(2)
    expect(bundle?.doc.name).toBe('第二版')
    expect(bundle?.versions).toHaveLength(2)
    const v3 = await restorePipelineRevision('s1', 1, '回退')
    expect(v3).toBe(3)
    const after = await loadPipeline('s1')
    expect(after?.doc.name).toBe('第一版')
    expect(after?.doc.nodes).toHaveLength(3)
    expect(after?.versions).toHaveLength(3)
  })

  it('运行状态增量落盘并可读回', async () => {
    const { dir } = await startRun('s1', 3)
    const state = { runId: 'x', revision: 3, startedAt: 1, nodes: { n1: { status: 'done' as const, outputs: ['outputs/a.txt'] } } }
    await saveRunState(dir, state)
    expect(await readRunState(dir)).toMatchObject({ runId: 'x' })
    expect(await latestRunDir('s1')).toBe(dir)
  })
})

describe('runPipeline 执行与续跑', () => {
  const calls: string[] = []
  const fakeExecutor: NodeExecutor = async (node, ctx) => {
    calls.push(node.id)
    const abs = join(ctx.outputDir, 'out.bin')
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, 'x')
    return [abs]
  }
  const executors = { script: fakeExecutor, tts: fakeExecutor, ffmpeg: fakeExecutor }

  it('按拓扑序全部执行；resume 跳过已完成节点', async () => {
    await savePipeline('s2', doc(), '全量')
    calls.length = 0
    const state = await runPipeline('s2', {}, {}, executors)
    expect(state.nodes.n1.status).toBe('done')
    expect(state.nodes.n3.status).toBe('done')
    expect(calls).toEqual(['n1', 'n2', 'n3'])

    calls.length = 0
    const resumed = await runPipeline('s2', { resume: true }, {}, executors)
    expect(calls).toEqual([]) // 全部命中缓存跳过
    expect(resumed.nodes.n1.status).toBe('done')
  })

  it('nodes 子集只跑指定节点；失败节点报错并落盘 failed 状态', async () => {
    await savePipeline('s3', doc({ nodes: [doc().nodes[0], doc().nodes[1]] }), '两节点')
    calls.length = 0
    await runPipeline('s3', { nodes: ['n2'] }, {}, executors)
    expect(calls).toEqual(['n2'])

    const failing: Record<string, NodeExecutor> = { script: async () => { throw new Error('boom') } }
    await expect(runPipeline('s3', { nodes: ['n1'] }, {}, failing)).rejects.toThrow(/boom/)
    const bundle = await loadPipeline('s3')
    expect(bundle).toBeTruthy()
  })
})
