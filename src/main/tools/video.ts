import type { ToolDefinition } from './index'
import { ensureVideoWorkspace, videoWorkspace } from '../videoMode'
import { synthesizeEdgeTts } from '../ttsEdge'
import { composeStoryboard, resolveWorkspacePath } from '../compose'
import { access, mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { getPipelineToolDefinitions } from './pipelineTools'

// 流水线/聊天工具与测试共用的纯函数
export { parseStoryboard, segmentArgs } from '../compose'
export { parseDurationMs } from '../ffmpeg'

/**
 * 视频模式工具：video_tts（Edge-TTS 配音）、video_compose（分镜合成）、video_files（文件列表）。
 * 合成与配音的核心实现分别抽在 compose.ts / ttsEdge.ts，与流水线节点共用；
 * 工作区按 ctx.sessionId 隔离在 userData/video/sessions/<id>/ 下。
 */

function requireSession(ctx: { sessionId?: string }): string {
  if (!ctx.sessionId) throw new Error('视频工具只能在视频模式会话中使用')
  return ctx.sessionId
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false)
}

export function getVideoToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'video_tts',
      description: '把一段旁白文本合成为语音（mp3）写入 outputs/。scene 填分镜镜头序号（从 1 开始）时固定保存为 voice-00N.mp3，video_compose 会自动匹配；不填 scene 需给 path。可用 voice 换音色、rate 调语速（如 "+10%"）。合成后返回实际时长。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '旁白文本，不超过 2000 字' },
          voice: { type: 'string', description: '音色名，默认 zh-CN-XiaoxiaoNeural（晓晓，中文女声）' },
          rate: { type: 'string', description: '语速相对变化，如 "+10%"、"-20%"' },
          scene: { type: 'integer', description: '对应分镜镜头序号（1 起）；存为 voice-00N.mp3 供合成自动匹配' },
          path: { type: 'string', description: '不填 scene 时的输出路径，outputs/ 下 mp3' },
        },
        required: ['text'],
      },
      kind: 'edit', timeoutMs: 120_000,
      async execute(input, ctx) {
        ctx.signal?.throwIfAborted()
        const sessionId = requireSession(ctx)
        const text = typeof input.text === 'string' ? input.text.trim() : ''
        if (!text) throw new Error('text 不能为空')
        if (text.length > 2000) throw new Error('text 不能超过 2000 字')
        const voice = typeof input.voice === 'string' && input.voice.trim() ? input.voice.trim() : undefined
        const ws = await ensureVideoWorkspace(sessionId)

        let target: string
        if (input.scene != null) {
          const scene = Math.floor(Number(input.scene))
          if (!Number.isInteger(scene) || scene < 1 || scene > 200) throw new Error('scene 必须是 1–200 的整数')
          target = resolve(ws.outputs, `voice-${String(scene).padStart(3, '0')}.mp3`)
          if (await exists(target)) throw new Error(`${target} 已存在；如需重做请先换 scene 或明确说明`)
        } else if (typeof input.path === 'string' && input.path.trim()) {
          target = await resolveWorkspacePath(sessionId, input.path.trim())
          if (!target.startsWith(ws.outputs + sep)) throw new Error('配音必须写入 outputs/')
          if (!target.toLowerCase().endsWith('.mp3')) throw new Error('输出必须是 .mp3')
          if (await exists(target)) throw new Error(`${target} 已存在，不覆盖`)
        } else {
          throw new Error('需要 scene（镜头序号）或 path（outputs/ 下路径）之一')
        }

        const ms = await synthesizeEdgeTts({
          outputsDir: ws.outputs, text, target, voice,
          rate: typeof input.rate === 'string' ? input.rate : undefined,
          onOutput: (message) => ctx.onOutput?.(`${message}\n`),
        })
        const fileName = resolve(target).split(sep).pop()
        return { content: `配音已生成：outputs/${fileName}（${ms ? `${(ms / 1000).toFixed(1)} 秒` : '时长未知'}，音色 ${voice ?? '默认'}）。可在任务文件面板试听。` }
      },
    },
    {
      name: 'video_compose',
      description: '按分镜脚本合成短视频 MP4 到 outputs/。每个镜头：有图片用图片（等比缩放居中，补黑边），否则用纯色底；有旁白音频（scene 对应 voice-00N.mp3 或镜头 audio 字段）时以音频定时长，否则用 duration（默认 3 秒）；text 作为字幕自动烧录在底部。输出永不覆盖，自动编号 video-N.mp4。合成前请先向用户展示分镜脚本。',
      inputSchema: {
        type: 'object',
        properties: {
          storyboard: {
            type: 'object',
            properties: {
              scenes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    image: { type: 'string', description: '图片素材相对路径（inputs/…），留空用纯色底' },
                    audio: { type: 'string', description: '旁白音频相对路径；缺省自动找 voice-00N.mp3' },
                    text: { type: 'string', description: '该镜头字幕' },
                    duration: { type: 'number', description: '无旁白时的镜头时长（秒，0.5–600）' },
                  },
                },
              },
              voice: { type: 'string', description: '本片使用的音色（记录用，配音由 video_tts 完成）' },
            },
            required: ['scenes'],
          },
        },
        required: ['storyboard'],
      },
      requiresApproval: true, kind: 'edit', timeoutMs: 600_000,
      async execute(input, ctx) {
        ctx.signal?.throwIfAborted()
        const sessionId = requireSession(ctx)
        const outPath = await composeStoryboard(sessionId, input.storyboard as never, {
          signal: ctx.signal,
          onOutput: (message) => ctx.onOutput?.(`${message}\n`),
        })
        const fileName = resolve(outPath).split(sep).pop()
        return { content: `合成完成：outputs/${fileName}。可在任务文件面板播放或打开。` }
      },
    },
    {
      name: 'video_files',
      description: '列出本视频任务已导入的素材（inputs/）和已生成的文件（outputs/），含字节大小。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      kind: 'read',
      async execute(_input, ctx) {
        ctx.signal?.throwIfAborted()
        const sessionId = requireSession(ctx)
        const ws = videoWorkspace(sessionId)
        const { readdir, stat } = await import('node:fs/promises')
        const list = async (dir: string): Promise<string[]> => {
          const names = await readdir(dir).catch(() => [] as string[])
          const rows: string[] = []
          for (const name of names.filter((x) => !x.startsWith('.')).sort()) {
            const s = await stat(resolve(dir, name)).catch(() => null)
            rows.push(`- ${resolve(dir, name) === resolve(ws.inputs, name) ? 'inputs/' : 'outputs/'}${name}（${s ? s.size : '?'} 字节）`)
          }
          return rows
        }
        await mkdir(ws.inputs, { recursive: true }).catch(() => undefined)
        await mkdir(ws.outputs, { recursive: true }).catch(() => undefined)
        const [inputs, outputs] = [await list(ws.inputs), await list(ws.outputs)]
        return { content: `inputs/：\n${inputs.join('\n') || '（空）'}\noutputs/：\n${outputs.join('\n') || '（空）'}` }
      },
    },
    ...getPipelineToolDefinitions(),
  ]
}
