import { access, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runFfmpeg, parseDurationMs } from './ffmpeg'

/**
 * Edge-TTS（微软 Edge 大声朗读接口）语音合成：video_tts 工具与流水线 tts 节点共用。
 * 免密钥；音色/语速可调；输出 24kHz 单声道 MP3。
 */

export const EDGE_TTS_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'
export const EDGE_TTS_MAX_CHARS = 2000

async function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false)
}

/** 合成一段文本到目标 mp3 路径；返回时长毫秒（未知为 null） */
export async function synthesizeEdgeTts(opts: {
  outputsDir: string
  text: string
  target: string
  voice?: string
  rate?: string
  onOutput?: (message: string) => void
}): Promise<number | null> {
  const text = opts.text.trim()
  const voice = opts.voice?.trim() || EDGE_TTS_DEFAULT_VOICE
  if (!text) throw new Error('text 不能为空')
  if (text.length > EDGE_TTS_MAX_CHARS) throw new Error(`text 不能超过 ${EDGE_TTS_MAX_CHARS} 字`)
  const rate = typeof opts.rate === 'string' && /^[+-]\d+%$/.test(opts.rate.trim()) ? opts.rate.trim() : undefined

  if (await fileExists(opts.target)) throw new Error(`${opts.target} 已存在，不覆盖`)
  opts.onOutput?.(`正在合成配音（${voice}）…`)
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts')
  const tts = new MsEdgeTTS()
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    const { audioFilePath } = await tts.toFile(opts.outputsDir, text, rate ? { rate } : undefined)
    if (resolve(audioFilePath) !== resolve(opts.target)) await rename(audioFilePath, opts.target)
  } finally {
    tts.close()
  }
  const probe = await runFfmpeg(['-i', opts.target], 15_000)
  return parseDurationMs(probe.stderr)
}
