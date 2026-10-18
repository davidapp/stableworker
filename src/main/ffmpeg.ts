import { app } from 'electron'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

/**
 * ffmpeg 二进制的获取与调用（视频模式合成引擎）。
 * 首次使用时自动下载（约 78MB，一次即可）：按平台从 ffmpeg-static 的 GitHub Releases
 * 下载独立二进制（无压缩包，免解压），存到 userData/bin/。下载进度经回调上报（工具卡片实时显示）。
 */

let cachedPath: string | null = null
let downloadPromise: Promise<string> | null = null

function binDir(): string {
  return join(app.getPath('userData'), 'bin')
}

export function ffmpegPath(): string {
  if (cachedPath) return cachedPath
  cachedPath = join(binDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  return cachedPath
}

/** 各平台的下载文件名（ffmpeg-static GitHub Releases 的资产命名） */
function releaseAssetName(): string {
  switch (process.platform) {
    case 'win32':
      return process.arch === 'arm64' ? 'ffmpeg-win32-arm64' : 'ffmpeg-win32-x64'
    case 'darwin':
      return process.arch === 'arm64' ? 'ffmpeg-mac-arm64' : 'ffmpeg-mac-x64'
    default:
      return process.arch === 'arm64' ? 'ffmpeg-linux-arm64' : 'ffmpeg-linux-amd64'
  }
}

/** 下载（跟随 GitHub 重定向），onProgress 以 0-100 上报 */
async function downloadTo(url: string, dest: string, onProgress?: (pct: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (total > 0 && onProgress) onProgress(Math.min(99, Math.round((received / total) * 100)))
  }
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, Buffer.concat(chunks))
  if (process.platform !== 'win32') {
    await chmod(dest, 0o755).catch(() => undefined)
  }
  onProgress?.(100)
}

/** 确保 ffmpeg 可用：存在则直接返回路径；缺失则自动下载（并发调用共享同一次下载） */
export function ensureFfmpeg(onProgress?: (pct: number) => void): Promise<string> {
  const path = ffmpegPath()
  const ready = async (): Promise<string> => {
    await access(path)
    return path
  }
  if (!downloadPromise) {
    downloadPromise = ready().catch(async () => {
      const url = `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/${releaseAssetName()}`
      await downloadTo(url, path, onProgress)
      downloadPromise = null
      return path
    })
  }
  return downloadPromise
}

/** 以 ffmpeg 执行一条参数序列，收集 stderr；resolve 于进程退出 */
export function runFfmpeg(args: string[], timeoutMs = 600_000): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(ffmpegPath(), args, { windowsHide: true })
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf8')
    if (stderr.length > 50_000) stderr = stderr.slice(-20_000)
  })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }, timeoutMs)
    timer.unref?.()
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stderr: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

/** 探测 ffmpeg 是否就绪（版本号输出即视为可用） */
export async function probeFfmpeg(): Promise<{ ok: boolean; version?: string; path: string }> {
  const path = ffmpegPath()
  try {
    await access(path)
  } catch {
    return { ok: false, path }
  }
  const r = await runFfmpeg(['-version'], 10_000)
  const m = /ffmpeg version (\S+)/.exec(r.stderr)
  return { ok: r.code === 0, version: m?.[1], path }
}
