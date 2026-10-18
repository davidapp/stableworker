import type { ToolDefinition } from './index'
import { ensureVideoWorkspace, videoWorkspace } from '../videoMode'
import { ensureFfmpeg, runFfmpeg } from '../ffmpeg'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

/**
 * 视频模式三工具：video_tts（Edge-TTS 配音）、video_compose（ffmpeg 分镜合成）、
 * video_files（工作区文件列表）。与办公工具同一套 ToolDefinition 模式；
 * 工作区按 ctx.sessionId 隔离在 userData/video/sessions/<id>/ 下。
 */

export interface StoryboardScene {
  image?: string
  audio?: string
  text?: string
  duration?: number
}

export interface Storyboard {
  scenes: StoryboardScene[]
  voice?: string
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])
export const VOICE_DEFAULT = 'zh-CN-XiaoxiaoNeural'

/** 工作区内相对路径 → 绝对路径，拒绝越界 */
function resolveIn(root: string, rel: string): string {
  if (!rel || rel.includes('\0')) throw new Error(`路径无效：${rel}`)
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`路径必须位于任务目录内：${rel}`)
  return abs
}

function extOf(p: string): string {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i).toLowerCase()
}

/** 校验分镜脚本（纯函数，测试用）：结构与取值非法时抛错并带镜头序号 */
export function parseStoryboard(value: unknown): Storyboard {
  if (!value || typeof value !== 'object') throw new Error('storyboard 必须是对象')
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) throw new Error('scenes 必须是非空数组（1–200 个镜头）')
  if (raw.scenes.length > 200) throw new Error('镜头最多 200 个')
  const scenes: StoryboardScene[] = raw.scenes.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`第 ${i + 1} 个镜头必须是对象`)
    const sc = s as Record<string, unknown>
    const scene: StoryboardScene = {}
    for (const [key, allowed] of [['image', IMAGE_EXTS], ['audio', AUDIO_EXTS]] as const) {
      const v = sc[key]
      if (v == null) continue
      if (typeof v !== 'string' || !v.trim()) throw new Error(`第 ${i + 1} 个镜头的 ${key} 必须是非空相对路径`)
      if (isAbsolute(v) || v.includes('\\') || v.split('/').includes('..')) throw new Error(`第 ${i + 1} 个镜头的 ${key} 必须是任务目录内的相对路径（正斜杠，如 inputs/a.jpg）`)
      if (!allowed.has(extOf(v))) throw new Error(`第 ${i + 1} 个镜头的 ${key} 格式不支持（${v}）`)
      scene[key] = v
    }
    if (sc.text != null) {
      if (typeof sc.text !== 'string' || sc.text.length > 2000) throw new Error(`第 ${i + 1} 个镜头的 text 必须是不超过 2000 字的字符串`)
      scene.text = sc.text
    }
    if (sc.duration != null) {
      if (typeof sc.duration !== 'number' || !Number.isFinite(sc.duration) || sc.duration < 0.5 || sc.duration > 600) throw new Error(`第 ${i + 1} 个镜头的 duration 必须在 0.5–600 秒之间`)
      scene.duration = sc.duration
    }
    return scene
  })
  const voice = typeof raw.voice === 'string' && raw.voice.trim() ? raw.voice.trim() : undefined
  if (voice && (voice.length > 100 || /[<>"{}|\\^`]/.test(voice))) throw new Error('voice 名称不合法')
  return { scenes, voice }
}

/** 从 ffmpeg -i 的 stderr 解析媒体时长（毫秒）；解析失败返回 null */
export function parseDurationMs(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!m) return null
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
}

/** drawtext 里引用路径的转义：反斜杠转正斜杠，冒号与引号加反斜杠 */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/** 各平台首个存在的中文字体（drawtext 烧字幕用）；找不到返回 null */
async function findCjkFont(): Promise<string | null> {
  const candidates = process.platform === 'win32'
    ? ['C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\simhei.ttf']
    : process.platform === 'darwin'
      ? ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Light.ttc', '/Library/Fonts/Arial Unicode.ttf']
      : ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc']
  for (const p of candidates) {
    if (await access(p).then(() => true, () => false)) return p
  }
  return null
}

/** 单个镜头的 ffmpeg 参数序列（纯函数，测试用）。image 缺省时用纯色底，audio 缺省时补静音轨。 */
export function segmentArgs(spec: { image?: string; audio?: string; durationSec: number; subtitleFile?: string; fontFile?: string; segmentPath: string }): string[] {
  const { image, audio, durationSec, subtitleFile, fontFile, segmentPath } = spec
  const args = ['-y']
  if (image) args.push('-loop', '1', '-framerate', '30', '-i', image)
  else args.push('-f', 'lavfi', '-i', 'color=c=0x101820:s=1280x720:r=30')
  if (audio) args.push('-i', audio)
  else args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo')

  const chain: string[] = []
  if (image) chain.push('scale=1280:720:force_original_aspect_ratio=decrease', 'pad=1280:720:(ow-iw)/2:(oh-ih)/2')
  chain.push('fps=30', 'format=yuv420p')
  if (subtitleFile && fontFile) {
    chain.push(`drawtext=fontfile='${escapeFilterPath(fontFile)}':textfile='${escapeFilterPath(subtitleFile)}':fontcolor=white:fontsize=34:box=1:boxcolor=black@0.45:boxborderw=16:x=(w-text_w)/2:y=h-text_h-64`)
  }
  args.push('-filter_complex', `[0:v]${chain.join(',')}[v]`, '-map', '[v]', '-map', '1:a', '-t', String(durationSec), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', segmentPath)
  return args
}

function requireSession(ctx: { sessionId?: string }): string {
  if (!ctx.sessionId) throw new Error('视频工具只能在视频模式会话中使用')
  return ctx.sessionId
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false)
}

/** outputs/ 下下一个不占用现有文件的 video-N.mp4 */
async function nextVideoOutput(outputsDir: string): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const p = resolve(outputsDir, `video-${n}.mp4`)
    if (!(await exists(p))) return p
  }
  throw new Error('outputs/ 下产物过多，请清理后重试')
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
          voice: { type: 'string', description: `音色名，默认 ${VOICE_DEFAULT}（晓晓，中文女声）` },
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
        const voice = typeof input.voice === 'string' && input.voice.trim() ? input.voice.trim() : VOICE_DEFAULT
        const rate = typeof input.rate === 'string' && /^[+-]\d+%$/.test(input.rate.trim()) ? input.rate.trim() : undefined
        const ws = await ensureVideoWorkspace(sessionId)

        let target: string
        if (input.scene != null) {
          const scene = Math.floor(Number(input.scene))
          if (!Number.isInteger(scene) || scene < 1 || scene > 200) throw new Error('scene 必须是 1–200 的整数')
          target = resolve(ws.outputs, `voice-${String(scene).padStart(3, '0')}.mp3`)
          if (await exists(target)) throw new Error(`${target} 已存在；如需重做请先换 scene 或明确说明`)
        } else if (typeof input.path === 'string' && input.path.trim()) {
          target = resolveIn(ws.root, input.path.trim())
          if (!target.startsWith(ws.outputs + sep)) throw new Error('配音必须写入 outputs/')
          if (extOf(target) !== '.mp3') throw new Error('输出必须是 .mp3')
          if (await exists(target)) throw new Error(`${target} 已存在，不覆盖`)
        } else {
          throw new Error('需要 scene（镜头序号）或 path（outputs/ 下路径）之一')
        }

        ctx.onOutput?.(`正在合成配音（${voice}）…\n`)
        const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts')
        const tts = new MsEdgeTTS()
        try {
          await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
          const { audioFilePath } = await tts.toFile(ws.outputs, text, rate ? { rate } : undefined)
          if (resolve(audioFilePath) !== target) await rename(audioFilePath, target)
        } finally {
          tts.close()
        }
        const probe = await runFfmpeg(['-i', target], 15_000)
        const ms = parseDurationMs(probe.stderr)
        return { content: `配音已生成：outputs/${resolve(target).split(sep).pop()}（${ms ? `${(ms / 1000).toFixed(1)} 秒` : '时长未知'}，音色 ${voice}）。字幕文本：${text.slice(0, 80)}${text.length > 80 ? '…' : ''}` }
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
        const ws = await ensureVideoWorkspace(sessionId)
        const sb = parseStoryboard(input.storyboard)
        await ensureFfmpeg((pct) => ctx.onOutput?.(`首次使用，正在下载合成引擎 ffmpeg：${pct}%\n`))

        const workDir = resolve(ws.outputs, '.work')
        const segDir = resolve(workDir, 'segments')
        await mkdir(segDir, { recursive: true })
        const font = await findCjkFont()
        if (!font) ctx.onOutput?.('未找到系统中文字体，本次合成不带字幕。\n')

        const n = sb.scenes.length
        const segNames: string[] = []
        for (let i = 0; i < n; i++) {
          ctx.signal?.throwIfAborted()
          const sc = sb.scenes[i]
          ctx.onOutput?.(`镜头 ${i + 1}/${n}：渲染中…\n`)

          let audioAbs: string | undefined
          if (sc.audio) {
            audioAbs = resolveIn(ws.root, sc.audio)
            if (!(await exists(audioAbs))) throw new Error(`第 ${i + 1} 个镜头的音频不存在：${sc.audio}`)
          } else {
            const conventional = resolve(ws.outputs, `voice-${String(i + 1).padStart(3, '0')}.mp3`)
            if (await exists(conventional)) audioAbs = conventional
          }

          let durationSec: number
          if (audioAbs) {
            const probe = await runFfmpeg(['-i', audioAbs], 15_000)
            const ms = parseDurationMs(probe.stderr)
            if (ms == null) throw new Error(`第 ${i + 1} 个镜头的音频时长无法读取：${audioAbs}`)
            durationSec = Math.max(0.5, ms / 1000 + 0.3)
          } else {
            durationSec = sc.duration ?? 3
          }

          let subtitleFile: string | undefined
          if (sc.text?.trim() && font) {
            subtitleFile = resolve(workDir, `sub-${String(i + 1).padStart(3, '0')}.txt`)
            await writeFile(subtitleFile, sc.text.trim(), 'utf8')
          }

          const segPath = resolve(segDir, `scene-${String(i + 1).padStart(3, '0')}.mp4`)
          const r = await runFfmpeg(segmentArgs({
            image: sc.image ? resolveIn(ws.root, sc.image) : undefined,
            audio: audioAbs, durationSec, subtitleFile, fontFile: font ?? undefined, segmentPath: segPath,
          }), 300_000)
          if (r.code !== 0) throw new Error(`第 ${i + 1} 个镜头渲染失败：${r.stderr.slice(-600)}`)
          segNames.push(`scene-${String(i + 1).padStart(3, '0')}.mp4`)
        }

        ctx.onOutput?.(`拼接 ${n} 个镜头…\n`)
        const listFile = resolve(segDir, 'list.txt')
        await writeFile(listFile, segNames.map((s) => `file '${s}'`).join('\n') + '\n', 'utf8')
        const outPath = await nextVideoOutput(ws.outputs)
        const final = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outPath], 300_000)
        if (final.code !== 0) throw new Error(`拼接失败：${final.stderr.slice(-600)}`)

        const lines = sb.scenes.map((sc, i) => {
          const parts = [`镜头${i + 1}`]
          parts.push(sc.image ?? '纯色底')
          if (sc.text?.trim()) parts.push(`字幕「${sc.text.trim().slice(0, 30)}${sc.text.trim().length > 30 ? '…' : ''}」`)
          return parts.join('：')
        })
        return { content: `合成完成：outputs/${resolve(outPath).split(sep).pop()}（${n} 个镜头，已烧录字幕${font ? '' : '——但未找到中文字体，本次无字幕'}）。\n${lines.join('\n')}\n可在任务产物面板播放或打开。` }
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
        const [inputs, outputs] = [await list(ws.inputs), await list(ws.outputs)]
        return { content: `inputs/：\n${inputs.join('\n') || '（空）'}\noutputs/：\n${outputs.join('\n') || '（空）'}` }
      },
    },
  ]
}
