import { BrowserWindow } from 'electron'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import pptxgen from 'pptxgenjs'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { getPath as pdfWorkerPath } from 'pdf-parse/worker'
import { PDFParse } from 'pdf-parse'
import type { OfficeFormat } from '../shared/types'

PDFParse.setWorker(pdfWorkerPath())
const MAX_EXTRACTED_CHARS = 100_000
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024

export interface OfficeDocumentInput {
  title: string
  paragraphs: string[]
  sheets: { name: string; rows: (string | number | boolean | null)[][] }[]
  slides: { title: string; bullets: string[]; notes?: string }[]
}

export function escapeOfficeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string)
}

export async function validateOfficeArchive(buffer: Buffer): Promise<JSZip> {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false })
  const entries = Object.values(zip.files)
  if (entries.length > 10_000) throw new Error('文档压缩包包含过多条目')
  let total = 0
  for (const entry of entries) {
    const size = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    total += size
    if (size > MAX_UNPACKED_BYTES || total > MAX_UNPACKED_BYTES) throw new Error('文档解压后超过 100 MB 上限')
  }
  return zip
}

export async function extractOfficeDocument(buffer: Buffer, format: OfficeFormat, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  let text = ''
  if (format === 'docx') {
    const zip = await validateOfficeArchive(buffer)
    if (!zip.file('word/document.xml')) throw new Error('不是有效的 DOCX 文档')
    text = (await mammoth.extractRawText({ buffer })).value
  } else if (format === 'xlsx') {
    const zip = await validateOfficeArchive(buffer)
    if (!zip.file('xl/workbook.xml')) throw new Error('不是有效的 XLSX 工作簿')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])
    const sections: string[] = []
    for (const sheet of workbook.worksheets.slice(0, 20)) {
      const rows: string[] = []
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1000) return
        rows.push(`${rowNumber}: ${Array.from({ length: Math.min(sheet.columnCount, 50) }, (_, i) => row.getCell(i + 1).text.replace(/\t|\n/g, ' ')).join('\t')}`)
      })
      sections.push(`工作表：${sheet.name}（${sheet.rowCount} 行，${sheet.columnCount} 列）\n${rows.join('\n')}${sheet.rowCount > 1000 ? '\n（仅显示前 1000 行）' : ''}`)
    }
    text = sections.join('\n\n')
  } else if (format === 'pptx') {
    const zip = await validateOfficeArchive(buffer)
    if (!zip.file('ppt/presentation.xml')) throw new Error('不是有效的 PPTX 演示文稿')
    const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true })
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]))
    const sections: string[] = []
    const collect = (value: unknown, out: string[]): void => {
      if (Array.isArray(value)) value.forEach((item) => collect(item, out))
      else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          if (key === 't' && (typeof item === 'string' || typeof item === 'number')) out.push(String(item))
          else collect(item, out)
        }
      }
    }
    for (const [i, slide] of slides.slice(0, 200).entries()) {
      signal?.throwIfAborted()
      const xml = await zip.file(slide)!.async('string')
      if (/<!DOCTYPE/i.test(xml)) throw new Error('文档不允许 DTD')
      const out: string[] = []
      collect(parser.parse(xml), out)
      sections.push(`幻灯片 ${i + 1}\n${out.join('\n')}`)
    }
    text = sections.join('\n\n')
  } else if (format === 'pdf') {
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('不是有效的 PDF 文件')
    const parser = new PDFParse({ data: Uint8Array.from(buffer), isEvalSupported: false })
    const onAbort = (): void => { void parser.destroy().catch(() => {}) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await parser.getText({ first: 200 })
      text = result.text.trim() ? result.text : '（PDF 没有可提取的文字，可能是扫描件；当前未提供 OCR）'
      // Chromium's CJK font maps can expose Kangxi-radical codepoints for ordinary Han characters.
      text = text.replace(/[\u2f00-\u2fd5]/g, (character) => character.normalize('NFKC'))
      if (result.total > 200) text += '\n（仅提取前 200 页）'
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await parser.destroy()
    }
  } else text = buffer.toString('utf-8')
  signal?.throwIfAborted()
  return text.length > MAX_EXTRACTED_CHARS ? `${text.slice(0, MAX_EXTRACTED_CHARS)}\n（已截断到 100000 字符）` : text
}

async function createPdf(input: OfficeDocumentInput, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  const win = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } })
  const onAbort = (): void => { if (!win.isDestroyed()) win.destroy() }
  signal?.addEventListener('abort', onAbort, { once: true })
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>@page{size:A4;margin:20mm}body{font:12pt -apple-system,BlinkMacSystemFont,'Microsoft YaHei','Noto Sans CJK SC',sans-serif;color:#111;line-height:1.65}h1{font-size:22pt;line-height:1.3}p{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escapeOfficeHtml(input.title)}</h1>${input.paragraphs.map((text) => `<p>${escapeOfficeHtml(text)}</p>`).join('')}</body></html>`
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    signal?.throwIfAborted()
    const buffer = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true })
    signal?.throwIfAborted()
    return buffer
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}

/** Generates actual OOXML/PDF bytes. No system interpreter or office-suite installation is required. */
export async function createOfficeDocument(format: OfficeFormat, input: OfficeDocumentInput, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  let buffer: Buffer
  if (format === 'docx') {
    const doc = new Document({ creator: 'StableWorker', title: input.title, sections: [{ children: [new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }), ...input.paragraphs.map((text) => new Paragraph({ children: [new TextRun(text)] }))] }] })
    buffer = await Packer.toBuffer(doc)
  } else if (format === 'xlsx') {
    const book = new ExcelJS.Workbook()
    book.creator = 'StableWorker'
    for (const spec of input.sheets) {
      const sheet = book.addWorksheet(spec.name)
      sheet.addRows(spec.rows)
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5E6AD2' } }
      sheet.columns.forEach((column) => { column.width = 24 })
      sheet.views = [{ state: 'frozen', ySplit: 1 }]
    }
    buffer = Buffer.from(await book.xlsx.writeBuffer())
  } else if (format === 'pptx') {
    const deck = new pptxgen()
    deck.layout = 'LAYOUT_WIDE'
    deck.author = 'StableWorker'
    deck.title = input.title
    deck.subject = input.title
    deck.theme = { headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei' }
    for (const spec of input.slides) {
      const slide = deck.addSlide()
      slide.background = { color: 'F4F4F5' }
      slide.addText(spec.title, { x: 0.7, y: 0.5, w: 12, h: 0.8, fontSize: 28, bold: true, color: '161618', breakLine: false })
      slide.addText(spec.bullets.map((text) => ({ text, options: { bullet: { indent: 18 }, breakLine: true } })), { x: 0.8, y: 1.7, w: 11.8, h: 4.8, fontSize: 20, color: '333333', paraSpaceAfter: 14, fit: 'shrink' })
      if (spec.notes) slide.addNotes(spec.notes)
    }
    buffer = await deck.write({ outputType: 'nodebuffer', compression: true }) as Buffer
  } else if (format === 'pdf') buffer = await createPdf(input, signal)
  else buffer = Buffer.from([input.title, ...input.paragraphs].join('\n\n'), 'utf-8')
  signal?.throwIfAborted()
  // Re-open bytes through the format parser before declaring a real artifact ready.
  await extractOfficeDocument(buffer, format, signal)
  return buffer
}
