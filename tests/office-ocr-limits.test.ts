import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  pageCount: 11,
  native: false,
  stallFirst: false,
  workers: [] as Array<{ terminated: boolean }>,
  rendered: [] as number[],
}))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
vi.mock('pdf-parse/worker', () => ({ getPath: () => '/fixture/pdf.worker.mjs' }))
vi.mock('pdf-parse', () => ({ PDFParse: class {
  static setWorker() {}
  async destroy() {}
  async getText(options: { partial?: number[]; first?: number }) {
    const all = Array.from({ length: fixture.pageCount }, (_, index) => ({ num: index + 1, text: fixture.native ? `Native page ${index + 1}` : '' }))
    return { total: fixture.pageCount, pages: options.partial ? all.filter((page) => options.partial!.includes(page.num)) : all.slice(0, options.first) }
  }
  async getInfo(options: { partial: number[] }) {
    return { total: fixture.pageCount, pages: options.partial.map((pageNumber) => ({ pageNumber, width: 100, height: 100 })) }
  }
  async getScreenshot(options: { partial: number[] }) {
    fixture.rendered.push(...options.partial)
    return { pages: [{ data: new Uint8Array([1]), width: 300, height: 300 }] }
  }
} }))
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  state = { terminated: false }
  ordinal: number
  constructor() {
    super()
    fixture.workers.push(this.state)
    this.ordinal = fixture.workers.length
    queueMicrotask(() => this.emit('message', { type: 'ready' }))
  }
  postMessage(message: { id: number }) {
    if (fixture.stallFirst && this.ordinal === 1) return
    queueMicrotask(() => this.emit('message', { type: 'result', id: message.id, text: 'Fixture OCR text', confidence: 95 }))
  }
  async terminate() { this.state.terminated = true; return 0 }
} }))

import { extractScannedPdf } from '../src/main/officeOcr'
const pdf = Buffer.from('%PDF-fixture')

beforeEach(() => {
  fixture.pageCount = 11
  fixture.native = false
  fixture.stallFirst = false
  fixture.workers.length = 0
  fixture.rendered.length = 0
})

describe('OCR 页面和资源调度边界', () => {
  it('自动识别最多10个无文字页，返回明确分页提示而不继续扫全篇', async () => {
    const result = await extractScannedPdf(pdf)
    expect(fixture.rendered).toEqual(Array.from({ length: 10 }, (_, index) => index + 1))
    expect(result.ocrPages).toHaveLength(10)
    expect(result.nextPages).toEqual([11])
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('尚未识别的扫描页：11')
    expect(result.text).toContain('每批最多 30 页')
    expect(fixture.workers).toEqual([{ terminated: true }])
  })

  it('200页检查上限下的已有文本也不启动OCR线程', async () => {
    fixture.native = true
    fixture.pageCount = 201
    const result = await extractScannedPdf(pdf)
    expect(result.pages).toHaveLength(200)
    expect(result.text).toContain('仅检查前 200 页')
    expect(fixture.workers).toHaveLength(0)
    expect(fixture.rendered).toHaveLength(0)
  })

  it('排队期间取消不创建第二个线程，释放队列后新任务正常完成', async () => {
    fixture.pageCount = 1
    fixture.stallFirst = true
    const firstController = new AbortController()
    const first = extractScannedPdf(pdf, { signal: firstController.signal })
    const firstStopped = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fixture.workers).toHaveLength(1))
    const secondController = new AbortController()
    const second = extractScannedPdf(pdf, { signal: secondController.signal })
    const secondStopped = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    await Promise.resolve()
    secondController.abort()
    await secondStopped
    expect(fixture.workers).toHaveLength(1)
    firstController.abort()
    await firstStopped
    const third = await extractScannedPdf(pdf)
    expect(third.text).toContain('Fixture OCR text')
    expect(fixture.workers).toEqual([{ terminated: true }, { terminated: true }])
  })
})
