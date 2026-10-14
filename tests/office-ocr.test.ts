import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ocrFixturePdf } from './helpers/ocrPdf'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
import { extractScannedPdf, pdfOcrRenderScale, PDF_OCR_LIMITS, resolveOcrAssets } from '../src/main/officeOcr'

describe('本地扫描 PDF OCR', () => {
  it('已有文本直接提取，完全不加载语言资源或识别worker', async () => {
    const progress = vi.fn()
    const result = await extractScannedPdf(ocrFixturePdf([{ text: 'Quarterly native report 2026' }]), { onProgress: progress })
    expect(result.text).toContain('Quarterly native report 2026')
    expect(result.pages).toEqual([expect.objectContaining({ source: 'text', confidence: null })])
    expect(result.ocrPages).toEqual([])
    expect(progress).toHaveBeenCalledTimes(1)
  })

  it('混合 PDF 保留原文，真实离线识别扫描页中的简体中文和英文', async () => {
    const image = await readFile(join(__dirname, 'fixtures', 'ocr-chinese-english.jpg'))
    const progress: Array<{ page: number; completed: number }> = []
    const result = await extractScannedPdf(ocrFixturePdf([{ text: 'Quarterly native report 2026' }, { image }]), { onProgress: (value) => progress.push(value) })
    expect(result.pages[0].source).toBe('text')
    expect(result.pages[1].source).toBe('ocr')
    expect(result.pages[1].text.replace(/\s/g, '')).toContain('会议纪要')
    expect(result.pages[1].text).toContain('StableWorker OCR 2026')
    expect(result.pages[1].confidence).toBeGreaterThan(50)
    expect(result.ocrPages).toEqual([2])
    expect(result.nextPages).toEqual([])
    expect(progress.at(-1)).toMatchObject({ page: 2, completed: 1 })
  }, 45_000)

  it('显式页码只识别所选扫描页', async () => {
    const image = await readFile(join(__dirname, 'fixtures', 'ocr-chinese-english.jpg'))
    const result = await extractScannedPdf(ocrFixturePdf([{ text: 'Do not OCR this page' }, { image }]), { pages: [2], languages: 'chi_sim+eng' })
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]).toMatchObject({ pageNumber: 2, source: 'ocr' })
    expect(result.text.replace(/\s/g, '')).toContain('项目进度确认')
  }, 45_000)

  it('初始化过程取消会立即终止owner与嵌套worker，之后仍能识别', async () => {
    const image = await readFile(join(__dirname, 'fixtures', 'ocr-chinese-english.jpg'))
    const controller = new AbortController()
    const pending = extractScannedPdf(ocrFixturePdf([{ image }]), { signal: controller.signal, onProgress: (value) => {
      if (value.status === 'initializing tesseract') controller.abort()
    } })
    // Trigger from initialization regardless of progress throttling.
    const timer = setTimeout(() => controller.abort(), 150)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    clearTimeout(timer)
    const result = await extractScannedPdf(ocrFixturePdf([{ image }]))
    expect(result.text).toContain('StableWorker OCR 2026')
  }, 45_000)

  it('识别阶段取消不返回部分成功，释放worker和串行队列', async () => {
    const image = await readFile(join(__dirname, 'fixtures', 'ocr-chinese-english.jpg'))
    const controller = new AbortController()
    const pending = extractScannedPdf(ocrFixturePdf([{ image }, { image }]), { signal: controller.signal, onProgress: (value) => {
      if (value.page === 1 && value.completed === 1) controller.abort()
    } })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const result = await extractScannedPdf(ocrFixturePdf([{ text: 'Native after cancel' }]))
    expect(result.text).toContain('Native after cancel')
  }, 45_000)

  it('文件、语言、页数、页码和像素分配都有上限', async () => {
    const buffer = ocrFixturePdf([{ text: 'Fixture' }])
    await expect(extractScannedPdf(Buffer.alloc(PDF_OCR_LIMITS.fileBytes + 1))).rejects.toThrow('25 MB')
    await expect(extractScannedPdf(Buffer.from('not pdf'))).rejects.toThrow('有效的 PDF')
    await expect(extractScannedPdf(buffer, { languages: ['../remote'] })).rejects.toThrow('当前支持')
    await expect(extractScannedPdf(buffer, { pages: Array.from({ length: 31 }, (_, index) => index + 1) })).rejects.toThrow('1 至 30')
    await expect(extractScannedPdf(buffer, { pages: [2] })).rejects.toThrow('超出范围')
    expect(() => pdfOcrRenderScale(Infinity, 100)).toThrow('页面尺寸')
    const scale = pdfOcrRenderScale(8000, 8000)
    expect((8000 * scale) ** 2).toBeLessThanOrEqual(PDF_OCR_LIMITS.pagePixels + 1)
    expect(resolveOcrAssets().workerPath).toContain('tesseract.js/src/worker-script/node/index.js')
  })
})
