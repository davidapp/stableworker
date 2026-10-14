import { app } from 'electron'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { PDFParse } from 'pdf-parse'
import { getPath as pdfWorkerPath } from 'pdf-parse/worker'

const requireLocal = createRequire(__filename)
export const PDF_OCR_LIMITS = {
  fileBytes: 25 * 1024 * 1024,
  inspectPages: 200,
  automaticPages: 10,
  explicitPages: 30,
  pagePixels: 12_000_000,
  pageDimension: 6000,
  pageTimeoutMs: 90_000,
} as const

export interface PdfOcrProgress {
  page: number
  completed: number
  total: number
  status: string
  progress: number
}
export interface PdfOcrPage {
  pageNumber: number
  text: string
  source: 'text' | 'ocr' | 'skipped'
  confidence: number | null
}
export interface PdfOcrResult {
  text: string
  totalPages: number
  pages: PdfOcrPage[]
  ocrPages: number[]
  nextPages: number[]
  truncated: boolean
}
export interface PdfOcrOptions {
  /** Explicit pages force OCR, even if a native text layer exists. */
  pages?: number[]
  languages?: string | string[]
  signal?: AbortSignal
  onProgress?: (progress: PdfOcrProgress) => void
}

function unpacked(path: string): string {
  return path.replace(/\.asar([\\/])/g, '.asar.unpacked$1')
}

/** The API/worker dependency tree stays outside ASAR; language files are extraResources. */
export function resolveOcrAssets(): { runnerPath: string; apiPath: string; workerPath: string; langPath: string } {
  const root = app.isPackaged ? join(process.resourcesPath, 'ocr') : join(app.getAppPath(), 'resources', 'ocr')
  const entry = requireLocal.resolve('tesseract.js')
  const apiPath = unpacked(entry)
  const workerPath = join(dirname(apiPath), 'worker-script', 'node', 'index.js')
  const runnerPath = join(root, 'runner.cjs')
  if (![apiPath, workerPath, runnerPath].every(existsSync)) throw new Error('本地 OCR 引擎资源缺失或未正确解包，请重新安装应用')
  return { runnerPath, apiPath, workerPath, langPath: join(root, 'tessdata') }
}

function stopped(signal?: AbortSignal): Error {
  const error = new Error(signal?.reason instanceof Error ? signal.reason.message : '本地 OCR 已停止')
  error.name = 'AbortError'
  return error
}

function waitFor<T>(operation: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, cancel: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const finish = (error: unknown, result?: T): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error); else resolve(result as T)
    }
    const onAbort = (): void => { cancel(); finish(stopped(signal)) }
    operation.then((result) => finish(null, result), (error) => finish(error))
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => {
      cancel()
      finish(new Error('本地 OCR 处理超时；请减少识别页数或使用更清晰的扫描件'))
    }, timeoutMs)
  })
}

class LocalOcrWorker {
  private thread: Worker
  private ready: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private requests = new Map<number, { resolve: (result: { text: string; confidence: number }) => void; reject: (error: Error) => void }>()
  private sequence = 0
  private termination?: Promise<number>
  private failure?: Error

  constructor(assets: ReturnType<typeof resolveOcrAssets>, languages: string[], onProgress: (status: string, progress: number) => void) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.thread = new Worker(assets.runnerPath, { workerData: { ...assets, languages } })
    this.thread.on('error', (error) => this.fail(error))
    this.thread.on('exit', (code) => { if (!this.termination) this.fail(new Error(`本地 OCR 引擎意外退出（${code}）`)) })
    this.thread.on('message', (message: { type: string; id?: number; text?: string; confidence?: number; status?: string; progress?: number; message?: string }) => {
      try {
        if (message.type === 'ready') this.readyResolve()
        else if (message.type === 'error') this.fail(new Error(message.message ?? '本地 OCR 引擎错误'))
        else if (message.type === 'progress') onProgress(message.status ?? '识别文字', message.progress ?? 0)
        else if (message.type === 'result' && message.id !== undefined) {
          this.requests.get(message.id)?.resolve({ text: message.text ?? '', confidence: message.confidence ?? 0 })
          this.requests.delete(message.id)
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  private fail(error: Error): void {
    this.failure ??= error
    this.readyReject(error)
    for (const pending of this.requests.values()) pending.reject(error)
    this.requests.clear()
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    await waitFor(this.ready, signal, 45_000, () => { void this.terminate() })
  }
  async recognize(data: Uint8Array, signal?: AbortSignal): Promise<{ text: string; confidence: number }> {
    signal?.throwIfAborted()
    if (this.failure) throw this.failure
    const id = ++this.sequence
    const result = new Promise<{ text: string; confidence: number }>((resolve, reject) => {
      this.requests.set(id, { resolve, reject })
      try { this.thread.postMessage({ type: 'recognize', id, data }) } catch (error) {
        this.requests.delete(id)
        reject(error)
      }
    })
    return waitFor(result, signal, PDF_OCR_LIMITS.pageTimeoutMs, () => { void this.terminate() })
  }
  terminate(): Promise<number> {
    if (!this.termination) {
      this.fail(new Error('本地 OCR 引擎已关闭'))
      this.termination = this.thread.terminate()
    }
    return this.termination
  }
}

let ocrQueue: Promise<void> = Promise.resolve()
async function acquireOcr(signal?: AbortSignal): Promise<() => void> {
  const previous = ocrQueue
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  ocrQueue = previous.catch(() => {}).then(() => gate)
  try { await waitFor(previous, signal, Number.POSITIVE_INFINITY, release); signal?.throwIfAborted() } catch (error) { release(); throw error }
  return release
}

/** Bounds canvas allocation before rendering, including unusual PDF page sizes. */
export function pdfOcrRenderScale(width: number, height: number): number {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0 && value <= 1_000_000)) throw new Error('PDF 页面尺寸无效或过大')
  return Math.min(3, PDF_OCR_LIMITS.pageDimension / width, PDF_OCR_LIMITS.pageDimension / height, Math.sqrt(PDF_OCR_LIMITS.pagePixels / (width * height)))
}

/** Local-only PDF extraction: retain native text and OCR empty pages, or explicitly selected pages. */
export async function extractScannedPdf(buffer: Buffer, opts: PdfOcrOptions = {}): Promise<PdfOcrResult> {
  opts.signal?.throwIfAborted()
  if (buffer.byteLength > PDF_OCR_LIMITS.fileBytes) throw new Error('PDF 文件超过本地 OCR 的 25 MB 上限')
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('不是有效的 PDF 文件')
  const languages = [...new Set(typeof opts.languages === 'string' ? opts.languages.split('+') : opts.languages ?? ['chi_sim', 'eng'])]
  if (!languages.length || languages.some((language) => language !== 'chi_sim' && language !== 'eng')) throw new Error('本地 OCR 当前支持 chi_sim（简体中文）和 eng（英文）')
  if (opts.pages && (!opts.pages.length || opts.pages.length > PDF_OCR_LIMITS.explicitPages || opts.pages.some((page) => !Number.isSafeInteger(page) || page < 1))) {
    throw new Error('每批 OCR 请指定 1 至 30 个有效页码（从 1 开始）')
  }
  const workerPath = pdfWorkerPath()
  PDFParse.setWorker(existsSync(unpacked(workerPath)) ? unpacked(workerPath) : workerPath)
  const parser = new PDFParse({ data: Uint8Array.from(buffer), isEvalSupported: false, maxImageSize: PDF_OCR_LIMITS.pagePixels })
  let client: LocalOcrWorker | undefined
  let release: (() => void) | undefined
  let page = 0
  let completed = 0
  let ocrTotal = 0
  let lastAt = 0
  let lastPage = -1
  let lastCompleted = -1
  const report = (status: string, progress: number): void => {
    if (opts.signal?.aborted) return
    const now = Date.now()
    if (page === lastPage && completed === lastCompleted && now - lastAt < 500) return
    lastAt = now; lastPage = page; lastCompleted = completed
    opts.onProgress?.({ page, completed, total: ocrTotal, status, progress: Math.max(0, Math.min(1, progress)) })
  }
  const onAbort = (): void => { void client?.terminate(); void parser.destroy().catch(() => {}) }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    report('检查 PDF 原有文字', 0)
    const selected = opts.pages ? [...new Set(opts.pages)].sort((a, b) => a - b) : undefined
    const text = await waitFor(parser.getText(selected ? { partial: selected } : { first: PDF_OCR_LIMITS.inspectPages }), opts.signal, 60_000, onAbort)
    if (selected?.some((number) => number > text.total)) throw new Error(`PDF 共 ${text.total} 页，指定页码超出范围`)
    const normalize = (value: string): string => value.replace(/[\u2f00-\u2fd5]/g, (character) => character.normalize('NFKC')).trim()
    const pages: PdfOcrPage[] = text.pages.map((item) => ({ pageNumber: item.num, text: normalize(item.text), source: 'text', confidence: null }))
    const candidates = selected ? pages : pages.filter((item) => !/[\p{L}\p{N}]/u.test(item.text))
    const toOcr = candidates.slice(0, selected ? PDF_OCR_LIMITS.explicitPages : PDF_OCR_LIMITS.automaticPages)
    const nextPages = candidates.slice(toOcr.length).map((item) => item.pageNumber)
    for (const pending of candidates) pending.source = 'skipped'
    ocrTotal = toOcr.length
    if (toOcr.length) {
      report('等待本地 OCR', 0)
      release = await acquireOcr(opts.signal)
      const assets = resolveOcrAssets()
      for (const language of languages) {
        const model = await stat(join(assets.langPath, `${language}.traineddata`)).catch(() => null)
        if (!model?.isFile() || !model.size || model.size > 50 * 1024 * 1024) throw new Error(`本地 OCR 语言文件 ${language} 缺失或无效，请重新安装应用`)
      }
      client = new LocalOcrWorker(assets, languages, report)
      await client.initialize(opts.signal)
      const info = await waitFor(parser.getInfo({ partial: toOcr.map((item) => item.pageNumber), parsePageInfo: true }), opts.signal, 60_000, onAbort)
      for (const item of toOcr) {
        opts.signal?.throwIfAborted()
        page = item.pageNumber
        report('渲染扫描页', 0)
        const dimensions = info.pages.find((value) => value.pageNumber === page)
        if (!dimensions) throw new Error(`无法获取 PDF 第 ${page} 页的尺寸`)
        const scale = pdfOcrRenderScale(dimensions.width, dimensions.height)
        const screenshots = await waitFor(parser.getScreenshot({ partial: [page], scale, imageBuffer: true, imageDataUrl: false }), opts.signal, 60_000, onAbort)
        const image = screenshots.pages[0]
        if (!image?.data.length || image.width * image.height > PDF_OCR_LIMITS.pagePixels + PDF_OCR_LIMITS.pageDimension * 2) throw new Error('PDF 扫描页渲染失败或超过像素上限')
        const result = await client.recognize(image.data, opts.signal)
        item.text = normalize(result.text)
        item.source = 'ocr'
        item.confidence = Number.isFinite(result.confidence) ? Math.max(0, Math.min(100, result.confidence)) : 0
        completed++
        report('扫描页识别完成', 1)
      }
    }
    opts.signal?.throwIfAborted()
    const truncated = nextPages.length > 0 || (!selected && text.total > PDF_OCR_LIMITS.inspectPages)
    const notes = [
      nextPages.length ? `尚未识别的扫描页：${nextPages.join(', ')}。请调用 office_ocr_pdf 并用 pages 分批指定，每批最多 30 页。` : '',
      !selected && text.total > PDF_OCR_LIMITS.inspectPages ? `仅检查前 ${PDF_OCR_LIMITS.inspectPages} 页；PDF 共 ${text.total} 页，请使用 office_ocr_pdf 指定后续页码。` : '',
    ].filter(Boolean)
    const output = pages.map((item) => `第 ${item.pageNumber} 页${item.source === 'ocr' ? `（本地 OCR，置信度 ${item.confidence?.toFixed(1)}%）` : ''}\n${item.source === 'skipped' ? '（扫描页尚未识别）' : item.text}`).join('\n\n')
    return { text: `${output.slice(0, 100_000)}${output.length > 100_000 ? '\n（文字超过 100000 字符，已截断）' : ''}${notes.length ? `\n\n${notes.join('\n')}` : ''}`, totalPages: text.total, pages, ocrPages: toOcr.map((item) => item.pageNumber), nextPages, truncated: truncated || output.length > 100_000 }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    await client?.terminate()
    release?.()
    await parser.destroy().catch(() => {})
  }
}
