import { writeFile, access } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import {
  loadPipeline, startRun, saveRunState, readRunState, latestRunDir, nodeOutputDir,
  topoSort, type PipelineDoc, type PipelineNode, type PipelineRunState, type NodeStatus,
} from './pipelineStore'
import { getMediaApiCapability } from './config'
import { synthesizeEdgeTts } from './ttsEdge'
import { composeStoryboard, type Storyboard } from './compose'

/**
 * 流水线执行引擎：按拓扑序执行节点，状态增量落盘（崩溃可续跑）。
 * 节点执行器可注入（测试用假执行器）；真实执行器：script/tts/ffmpeg 内建，
 * image 走 OpenAI 兼容 images API（火山方舟/即梦 seedream、SiliconFlow 等通用），
 * video/asr 节点等待对应能力接入。
 */

export interface RunContext {
  signal?: AbortSignal
  onOutput?: (message: string) => void
}

export interface NodeRunContext extends RunContext {
  sessionId: string
  runDir: string
  /** 输入槽 → 依赖节点产物的绝对路径 */
  inputs: Record<string, string>
  /** 本节点产物目录（绝对路径） */
  outputDir: string
}

/** 执行单个节点，返回产物（工作区相对路径） */
export type NodeExecutor = (node: PipelineNode, ctx: NodeRunContext) => Promise<string[]>

function relFromWorkspace(root: string, abs: string): string {
  return resolve(abs).startsWith(root + sep) ? resolve(abs).slice(root.length + 1).split(sep).join('/') : resolve(abs)
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false)
}

/** OpenAI 兼容 images API（火山方舟即梦 seedream、SiliconFlow 等通用） */
async function runImageNode(node: PipelineNode, ctx: NodeRunContext): Promise<string[]> {
  const cfg = await getMediaApiCapability('textToImage')
  if (!cfg) throw new Error('文生图尚未配置：设置 → 媒体 API → 文生图，填入接口地址与 API Key（即梦 seedream 走火山方舟 OpenAI 兼容端点）')
  const prompt = typeof node.params.prompt === 'string' ? node.params.prompt.trim() : ''
  if (!prompt) throw new Error(`节点 ${node.name} 缺少 prompt 参数`)
  const size = typeof node.params.size === 'string' ? node.params.size : '1024x1024'
  ctx.onOutput?.(`调用文生图（${cfg.model || '默认模型'}）…`)
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, prompt, size, response_format: 'b64_json', n: 1 }),
    signal: ctx.signal,
  })
  if (!res.ok) throw new Error(`文生图 API 返回 ${res.status}：${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> }
  const item = data.data?.[0]
  if (!item) throw new Error('文生图 API 未返回图片数据')
  let bytes: Buffer
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, 'base64')
  } else if (item.url) {
    const img = await fetch(item.url, { signal: ctx.signal })
    if (!img.ok) throw new Error(`下载生成图片失败：HTTP ${img.status}`)
    bytes = Buffer.from(await img.arrayBuffer())
  } else {
    throw new Error('文生图 API 返回中既无 b64_json 也无 url')
  }
  const outPath = resolve(ctx.outputDir, 'image.png')
  await writeFile(outPath, bytes)
  return [outPath]
}

function requireUnconfigured(capabilityLabel: string): never {
  throw new Error(`${capabilityLabel}节点暂未接入：等待媒体 API 对应能力的调用实现（配置页可先填好参数）`)
}

/** 真实节点执行器（生产用） */
export const defaultExecutors: Record<string, NodeExecutor> = {
  async script(node, ctx) {
    const text = typeof node.params.text === 'string' ? node.params.text : ''
    if (!text.trim()) throw new Error(`节点 ${node.name} 缺少 text 参数`)
    const outPath = resolve(ctx.outputDir, 'script.txt')
    await writeFile(outPath, text, 'utf8')
    ctx.onOutput?.(`文案 ${text.length} 字已写入。`)
    return [outPath]
  },
  async tts(node, ctx) {
    const text = typeof node.params.text === 'string' ? node.params.text.trim() : ''
    if (!text) throw new Error(`节点 ${node.name} 缺少 text 参数`)
    const target = resolve(ctx.outputDir, 'voice.mp3')
    const ms = await synthesizeEdgeTts({
      outputsDir: ctx.outputDir, text, target,
      voice: typeof node.params.voice === 'string' ? node.params.voice : undefined,
      rate: typeof node.params.rate === 'string' ? node.params.rate : undefined,
      onOutput: (m) => ctx.onOutput?.(m),
    })
    ctx.onOutput?.(ms ? `配音 ${(ms / 1000).toFixed(1)} 秒。` : '配音完成。')
    return [target]
  },
  async ffmpeg(node, ctx) {
    const storyboard = node.params.storyboard as Storyboard | undefined
    if (!storyboard) throw new Error(`节点 ${node.name} 缺少 storyboard 参数`)
    const outPath = await composeStoryboard(ctx.sessionId, storyboard, ctx)
    return [outPath]
  },
  async image(node, ctx) {
    return runImageNode(node, ctx)
  },
  async video() {
    requireUnconfigured('文生视频/图生视频')
  },
  async asr() {
    requireUnconfigured('语音识别')
  },
}

export interface RunOptions {
  /** 只跑这些节点（不含依赖） */
  nodes?: string[]
  /** 从该节点起跑到结尾（拓扑序） */
  from?: string
  /** 跳过上次运行已成功的节点（产物仍存在才跳过） */
  resume?: boolean
}

/** 解析执行目标与顺序（纯函数，测试用） */
export function planTargets(doc: PipelineDoc, opts: RunOptions): PipelineNode[] {
  const order = topoSort(doc)
  if (opts.from) {
    const idx = order.findIndex((n) => n.id === opts.from)
    if (idx < 0) throw new Error(`起点节点不存在：${opts.from}`)
    return order.slice(idx)
  }
  if (opts.nodes?.length) {
    const wanted = new Set(opts.nodes)
    const subset = order.filter((n) => wanted.has(n.id))
    const missing = opts.nodes.filter((id) => !subset.some((n) => n.id === id))
    if (missing.length) throw new Error(`节点不存在：${missing.join(', ')}`)
    return subset
  }
  return order
}

/** 执行流水线：返回最终运行状态（也已落盘） */
export async function runPipeline(
  sessionId: string,
  opts: RunOptions,
  ctx: RunContext = {},
  executors: Record<string, NodeExecutor> = defaultExecutors,
): Promise<PipelineRunState> {
  const bundle = await loadPipeline(sessionId)
  if (!bundle) throw new Error('尚未创建流水线：先用 pipeline_write 生成')
  const doc = bundle.doc
  const targets = planTargets(doc, opts)
  const ws = await (await import('./videoMode')).ensureVideoWorkspace(sessionId)

  // 运行目录：resume 沿用最近一次，否则新建
  let runDir: string
  let state: PipelineRunState
  if (opts.resume) {
    const prevDir = await latestRunDir(sessionId)
    const prevState = prevDir ? await readRunState(prevDir) : null
    if (prevDir && prevState && prevState.revision === bundle.revision) {
      runDir = prevDir
      state = prevState
    } else {
      throw new Error('没有可续跑的运行（或流水线已更新版本），请直接重新运行')
    }
  } else {
    const fresh = await startRun(sessionId, bundle.revision)
    runDir = fresh.dir
    state = { runId: fresh.runId, revision: bundle.revision, startedAt: Date.now(), nodes: {} }
  }

  ctx.onOutput?.(`流水线「${doc.name}」v${bundle.revision}：${targets.length} 个节点待执行${opts.resume ? '（续跑，已完成节点自动跳过）' : ''}。`)

  for (const node of targets) {
    ctx.signal?.throwIfAborted()
    const prior = state.nodes[node.id]
    if (opts.resume && prior?.status === 'done' && (prior.outputs ?? []).length && (await Promise.all(prior.outputs!.map((rel) => exists(resolve(ws.root, rel))))).every(Boolean)) {
      ctx.onOutput?.(`跳过 ${node.name}（已完成且产物在）。`)
      continue
    }
    if (node.enabled === false) {
      state.nodes[node.id] = { ...(prior ?? {}), status: 'disabled' as NodeStatus }
      await saveRunState(runDir, state)
      continue
    }
    // 收集输入槽：inputFrom 指向节点的第一个产物
    const inputs: Record<string, string> = {}
    for (const [slot, depId] of Object.entries(node.inputFrom ?? {})) {
      const depOutputs = state.nodes[depId]?.outputs ?? []
      if (depOutputs.length) inputs[slot] = resolve(ws.root, depOutputs[0])
    }
    const executor = executors[node.type]
    state.nodes[node.id] = { ...(prior ?? {}), status: 'running' as NodeStatus, startedAt: Date.now() }
    await saveRunState(runDir, state)
    ctx.onOutput?.(`▶ ${node.name}（${node.type}）`)
    const outputDir = await nodeOutputDir(sessionId, node.id)
    try {
      const rawOutputs = await executor(node, {
        sessionId, runDir, signal: ctx.signal, onOutput: ctx.onOutput, inputs, outputDir,
      })
      const outputs = rawOutputs.map((p) => resolve(outputDir, p))
      state.nodes[node.id] = {
        status: 'done' as NodeStatus,
        outputs: outputs.map((abs) => relFromWorkspace(ws.root, abs)),
        startedAt: state.nodes[node.id]?.startedAt, finishedAt: Date.now(),
      }
      ctx.onOutput?.(`✔ ${node.name} 完成。`)
    } catch (err) {
      state.nodes[node.id] = {
        status: 'failed' as NodeStatus,
        error: err instanceof Error ? err.message : String(err),
        startedAt: state.nodes[node.id]?.startedAt, finishedAt: Date.now(),
      }
      await saveRunState(runDir, state)
      ctx.onOutput?.(`✘ ${node.name} 失败：${state.nodes[node.id].error}`)
      throw new Error(`节点「${node.name}」执行失败：${state.nodes[node.id].error}（可修复后用 resume 从此处继续）`)
    }
    await saveRunState(runDir, state)
  }

  state.finishedAt = Date.now()
  await saveRunState(runDir, state)
  const done = Object.values(state.nodes).filter((s) => s.status === 'done').length
  ctx.onOutput?.(`流水线结束：${done}/${doc.nodes.length} 个节点成功。`)
  return state
}
