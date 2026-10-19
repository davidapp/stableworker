import { access, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { runFfmpeg, parseDurationMs } from './ffmpeg'
import { ensureVideoWorkspace, resolveVideoFile } from './videoMode'

/**
 * 分镜合成核心：按镜头逐个渲染 1280x720 片段（图片等比补边/纯色底、drawtext 烧字幕、
 * 旁白定时长）再 concat 成 MP4。video_compose 工具与流水线 ffmpeg 节点共用。
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
export function parseDurationString(stderr: string): number | null {
  return parseDurationMs(stderr)
}

export { parseDurationMs } from './ffmpeg'

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

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false)
}

async function nextVideoOutput(outputsDir: string): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const p = resolve(outputsDir, `video-${n}.mp4`)
    if (!(await exists(p))) return p
  }
  throw new Error('outputs/ 下产物过多，请清理后重试')
}

export interface ComposeContext {
  signal?: AbortSignal
  onOutput?: (message: string) => void
}

/** 按分镜合成 MP4；返回产物绝对路径。产物自动编号 video-N.mp4，不覆盖已有文件。 */
export async function composeStoryboard(sessionId: string, storyboard: Storyboard, ctx: ComposeContext = {}): Promise<string> {
  const ws = await ensureVideoWorkspace(sessionId)
  const sb = parseStoryboard(storyboard)
  await ensureFfmpegAvailable(ctx)
  const workDir = resolve(ws.outputs, '.work')
  const segDir = resolve(workDir, 'segments')
  await mkdir(segDir, { recursive: true })
  const font = await findCjkFont()
  if (!font) ctx.onOutput?.('未找到系统中文字体，本次合成不带字幕。')

  const n = sb.scenes.length
  const segNames: string[] = []
  for (let i = 0; i < n; i++) {
    ctx.signal?.throwIfAborted()
    const sc = sb.scenes[i]
    ctx.onOutput?.(`镜头 ${i + 1}/${n}：渲染中…`)

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

  ctx.onOutput?.(`拼接 ${n} 个镜头…`)
  const listFile = resolve(segDir, 'list.txt')
  await writeFile(listFile, segNames.map((s) => `file '${s}'`).join('\n') + '\n', 'utf8')
  const outPath = await nextVideoOutput(ws.outputs)
  const final = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outPath], 300_000)
  if (final.code !== 0) throw new Error(`拼接失败：${final.stderr.slice(-600)}`)
  return outPath
}

async function ensureFfmpegAvailable(ctx: ComposeContext): Promise<void> {
  const { ensureFfmpeg } = await import('./ffmpeg')
  await ensureFfmpeg((message) => ctx.onOutput?.(message))
}

/** 校验并解析工作区内相对路径（流水线节点产物引用用） */
export async function resolveWorkspacePath(sessionId: string, rel: string): Promise<string> {
  const ws = await ensureVideoWorkspace(sessionId)
  return resolveVideoFile(ws, rel)
}
