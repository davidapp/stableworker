import type { ToolDefinition } from './index'
import {
  validatePipeline, loadPipeline, savePipeline, latestRunDir, readRunState,
  type PipelineDoc, type PipelineRunState,
} from '../pipelineStore'
import { runPipeline } from '../pipelineRunner'

/**
 * 聊天驱动的流水线三工具：pipeline_write（生成/更新，追加新版本）、
 * pipeline_run（全量/指定节点/续跑）、pipeline_read（读回当前版本与最近运行状态）。
 * 可视化面板（P1）与单步调试（P2）在此基础上叠加。
 */

function requireSession(ctx: { sessionId?: string }): string {
  if (!ctx.sessionId) throw new Error('流水线工具只能在视频模式会话中使用')
  return ctx.sessionId
}

function summarize(doc: PipelineDoc): string {
  return doc.nodes.map((n, i) => `${i + 1}. ${n.name}（${n.type}${n.enabled === false ? '，已禁用' : ''}）${n.deps.length ? ` ← 依赖 ${n.deps.join('/')}` : ''}`).join('\n')
}

function summarizeState(state: PipelineRunState): string {
  return Object.entries(state.nodes).map(([id, s]) => `- ${id}: ${s.status}${s.error ? `（${s.error.slice(0, 120)}）` : ''}${s.outputs?.length ? ` → ${s.outputs.join(', ')}` : ''}`).join('\n')
}

export function getPipelineToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'pipeline_write',
      description: '把用户需求整理为流水线工程并保存（每次保存生成新版本，支持回退）。节点类型：script（文案）、tts（配音）、ffmpeg（分镜合成，参数 storyboard 同 video_compose）、image（文生图，参数 prompt/size）、video（文生视频/图生视频）、asr（语音识别）。用 deps 声明执行顺序，inputFrom 把上游产物接到输入槽（如 {"image":"n1"}）。已有流水线时传入完整新结构（增量修改前先 pipeline_read）。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '流水线名称，1–100 字' },
          note: { type: 'string', description: '本版本备注（改了什么、为什么）' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '字母开头，≤32 位字母数字-_' },
                type: { type: 'string', description: 'script | tts | ffmpeg | image | video | asr' },
                name: { type: 'string' },
                params: { type: 'object', description: '节点参数：script{text} tts{text,voice,rate} ffmpeg{storyboard} image{prompt,size}' },
                deps: { type: 'array', items: { type: 'string' }, description: '前置节点 id 列表' },
                inputFrom: { type: 'object', description: '输入槽 → 节点 id，如 {"image":"n0"}' },
                enabled: { type: 'boolean' },
              },
              required: ['id', 'type', 'name'],
            },
          },
        },
        required: ['name', 'nodes'],
      },
      kind: 'edit', timeoutMs: 30_000,
      async execute(input, ctx) {
        ctx.signal?.throwIfAborted()
        const sessionId = requireSession(ctx)
        const doc = validatePipeline({ schema: 1, name: input.name, nodes: input.nodes })
        const revision = await savePipeline(sessionId, doc, typeof input.note === 'string' ? input.note.slice(0, 200) : '')
        return { content: `流水线「${doc.name}」已保存为 v${revision}（${doc.nodes.length} 个节点）：\n${summarize(doc)}\n可用 pipeline_run 执行；历史版本可在后续版本 UI 中回退。` }
      },
    },
    {
      name: 'pipeline_run',
      description: '执行当前流水线。默认全量；nodes 只跑指定节点；from 从某节点跑到结尾；resume=true 续跑上次运行（已成功且产物仍在的节点自动跳过）。节点失败会带上错误与继续建议。',
      inputSchema: {
        type: 'object',
        properties: {
          nodes: { type: 'array', items: { type: 'string' }, description: '只执行这些节点 id' },
          from: { type: 'string', description: '从该节点起执行到结尾' },
          resume: { type: 'boolean', description: '续跑最近一次运行' },
        },
        required: [],
      },
      requiresApproval: true, kind: 'edit', timeoutMs: 900_000,
      async execute(input, ctx) {
        ctx.signal?.throwIfAborted()
        const sessionId = requireSession(ctx)
        const state = await runPipeline(sessionId, {
          nodes: Array.isArray(input.nodes) ? (input.nodes as string[]) : undefined,
          from: typeof input.from === 'string' ? input.from : undefined,
          resume: input.resume === true,
        }, { signal: ctx.signal, onOutput: (m) => ctx.onOutput?.(`${m}\n`) })
        return { content: `流水线运行结束（run ${state.runId}）：\n${summarizeState(state)}` }
      },
    },
    {
      name: 'pipeline_read',
      description: '读取当前流水线（版本、节点结构）与最近一次运行的状态，用于修改前了解现状或向用户汇报进度。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      kind: 'read',
      async execute(_input, ctx) {
        ctx.signal?.throwIfAborted()
        const sessionId = requireSession(ctx)
        const bundle = await loadPipeline(sessionId)
        if (!bundle) return { content: '该任务还没有流水线。用 pipeline_write 创建。' }
        let runInfo = '（最近没有运行记录）'
        const runDir = await latestRunDir(sessionId)
        if (runDir) {
          const state = await readRunState(runDir)
          if (state) runInfo = `最近运行 ${state.runId}（v${state.revision}）：\n${summarizeState(state)}`
        }
        return { content: `当前流水线 v${bundle.revision}「${bundle.doc.name}」（共 ${bundle.versions.length} 个版本）：\n${summarize(bundle.doc)}\n\n${runInfo}` }
      },
    },
  ]
}
