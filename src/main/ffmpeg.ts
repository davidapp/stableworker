import { app } from 'electron'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

/**
 * ffmpeg 二进制的获取与调用（视频模式合成引擎）。
 * 解析顺序：已解析缓存 → userData/bin 本地文件（支持手动放置）→ 系统 PATH → 自动下载。
 * 下载源：GitHub 直连 → ghfast.top / ghproxy.net 镜像 → npmmirror 二进制镜像。
 * 主进程 fetch（undici）默认不走 HTTP(S)_PROXY，显式检测并挂代理（国内网络的关键）。
 */

let resolvedPath: string | null = null
let downloadPromise: Promise<string> | null = null

function localBinPath(): string {
  return join(app.getPath('userData'), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
}

/** 当前用于执行的 ffmpeg；解析完成前返回本地待下载路径 */
export function ffmpegPath(): string {
  return resolvedPath ?? localBinPath()
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

const GITHUB_LATEST = `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/${releaseAssetName()}`

function proxyForFetch(): string | null {
  return process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? null
}

/** 环境变量里配了代理就显式挂上（undici fetch 默认忽略代理环境变量） */
async function fetcher(url: string, redirect: 'follow' | 'manual' = 'follow'): Promise<Response> {
  const proxy = proxyForFetch()
  if (proxy) {
    const { fetch: undiciFetch, ProxyAgent } = await import('undici')
    return undiciFetch(url, { redirect, dispatcher: new ProxyAgent(proxy) }) as unknown as Response
  }
  return fetch(url, { redirect })
}

async function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false)
}

/** 系统 PATH 里已有 ffmpeg（如开发者本机装过）就直接用，免去下载 */
function trySystemFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'ffmpeg' : 'ffmpeg', ['-version'], { windowsHide: true })
    let settled = false
    const done = (ok: boolean): void => { if (!settled) { settled = true; try { child.kill() } catch { /* 已退出 */ } resolve(ok) } }
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
    setTimeout(() => done(false), 8000).unref?.()
  })
}

/** npmmirror 二进制镜像：列目录取最新版本 tag，拼出资产地址；失败返回 null */
async function npmmirrorAssetUrl(): Promise<string | null> {
  try {
    const res = await fetcher('https://registry.npmmirror.com/-/binary/ffmpeg-static/')
    if (!res.ok) return null
    const entries = (await res.json()) as Array<{ name?: string; type?: string; date?: string }>
    const dirs = entries.filter((e) => e.type === 'dir' && typeof e.name === 'string')
    dirs.sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? ''))
    const tag = dirs[0]?.name?.replace(/\/$/, '')
    return tag ? `https://registry.npmmirror.com/-/binary/ffmpeg-static/${tag}/${releaseAssetName()}` : null
  } catch {
    return null
  }
}

interface DownloadSource {
  label: string
  url: () => Promise<string | null>
}

/** 下载单个源（跟随重定向），onProgress 以 0-100 上报；失败抛错由调用方换下一个源 */
async function downloadTo(url: string, dest: string, label: string, onProgress?: (message: string) => void): Promise<void> {
  const res = await fetcher(url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (total > 0 && onProgress) onProgress(`通过${label}下载合成引擎：${Math.min(99, Math.round((received / total) * 100))}%`)
  }
  if (received < 1_000_000) throw new Error(`响应过小（${received} 字节），疑似不可用`)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, Buffer.concat(chunks))
  if (process.platform !== 'win32') await chmod(dest, 0o755).catch(() => undefined)
}

/** 确保 ffmpeg 可用；自动下载时并发调用共享同一次尝试，全部源失败时给出可操作的手动安装指引 */
export async function ensureFfmpeg(onProgress?: (message: string) => void): Promise<string> {
  if (resolvedPath) {
    if (resolvedPath === 'ffmpeg' || (await fileExists(resolvedPath))) return resolvedPath
    resolvedPath = null // 本地文件被删了，重新解析
  }
  if (!downloadPromise) {
    downloadPromise = (async (): Promise<string> => {
      const local = localBinPath()
      if (await fileExists(local)) {
        resolvedPath = local
        return local
      }
      onProgress?.('正在探测系统 ffmpeg…')
      if (await trySystemFfmpeg()) {
        resolvedPath = 'ffmpeg'
        onProgress?.('使用系统安装的 ffmpeg。')
        return 'ffmpeg'
      }
      onProgress?.('本机没有 ffmpeg，开始自动下载（约 78 MB，一次即可）…')
      const sources: DownloadSource[] = [
        { label: 'GitHub', url: async () => GITHUB_LATEST },
        { label: '镜像 ghfast.top', url: async () => `https://ghfast.top/${GITHUB_LATEST}` },
        { label: '镜像 ghproxy.net', url: async () => `https://ghproxy.net/${GITHUB_LATEST}` },
        { label: 'npmmirror 镜像', url: npmmirrorAssetUrl },
      ]
      const failures: string[] = []
      for (const source of sources) {
        let url: string | null = null
        try {
          url = await source.url()
        } catch { continue }
        if (!url) continue
        try {
          onProgress?.(`尝试通过${source.label}下载…`)
          await downloadTo(url, local, source.label, onProgress)
          resolvedPath = local
          onProgress?.('下载完成。')
          return local
        } catch (err) {
          failures.push(`${source.label}：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      throw new Error(
        `ffmpeg 自动下载失败（${failures.join('；')}）。` +
        `可手动下载 ffmpeg-${process.platform === 'win32' ? 'win32-x64' : releaseAssetName()} 后放到：${local}`,
      )
    })()
  }
  return downloadPromise.finally(() => { downloadPromise = null })
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
