import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '', pdf: Buffer.alloc(0) as Buffer, html: '', destroyed: false, options: {} as Record<string, unknown> }))
vi.mock('electron', () => ({
  app: { getPath: () => state.root }, ipcMain: { handle: vi.fn() }, safeStorage: {}, dialog: {}, shell: {},
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) { state.options = options; state.destroyed = false }
    async loadURL(url: string) { state.html = decodeURIComponent(url.split(',').slice(1).join(',')) }
    isDestroyed() { return state.destroyed }
    destroy() { state.destroyed = true }
    webContents = { printToPDF: async () => state.pdf }
  },
}))
import { copyOfficeAttachments, ensureOfficeWorkspace, extractOfficeFile, listOfficeFiles, resolveOfficeFile } from '../src/main/office'
import { createOfficeDocument, escapeOfficeHtml, extractOfficeDocument, type OfficeDocumentInput } from '../src/main/officeDocuments'
import { canSymlink } from './helpers'
import { getOfficeToolDefinitions } from '../src/main/tools/office'

/** Valid standalone text PDF fixture, including byte-accurate xref offsets. */
function pdfFixture(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 44 >>\nstream\nBT /F1 12 Tf 50 750 Td (Office report) Tj ET\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

const document: OfficeDocumentInput = {
  title: '办公任务验证', paragraphs: ['这是真实生成的报告。', '第二段包含 & < > 等字符。'],
  sheets: [{ name: '数据', rows: [['部门', '数量'], ['研发', 12], ['完成', true]] }],
  slides: [{ title: '进展汇报', bullets: ['目标已完成', '下一步计划'], notes: '演讲备注' }],
}

beforeEach(async () => { state.root = await mkdtemp(join(tmpdir(), 'stableworker-office-')); state.pdf = pdfFixture() })
afterEach(async () => { await rm(state.root, { recursive: true, force: true }) })

describe('独立办公任务与文档产物', () => {
  it('任务目录不依赖用户项目，导入是原文件的字节副本，任务之间不可访问', async () => {
    const source = join(state.root, '资料.docx')
    const bytes = await createOfficeDocument('docx', document)
    await writeFile(source, bytes)
    const first = await ensureOfficeWorkspace('task-one')
    const second = await ensureOfficeWorkspace('task-two')
    const files = await copyOfficeAttachments(first, [source])
    expect(files[0]).toMatchObject({ role: 'input', format: 'docx', size: bytes.length })
    expect(await readFile(join(first, files[0].path))).toEqual(bytes)
    expect(await readFile(source)).toEqual(bytes)
    expect(await extractOfficeFile(first, files[0].path)).toContain('这是真实生成的报告')
    await expect(resolveOfficeFile(second, files[0].path)).rejects.toThrow()
    await expect(resolveOfficeFile(first, '../task-two/inputs/x.docx')).rejects.toThrow('路径无效')
    await expect(ensureOfficeWorkspace('../outside')).rejects.toThrow('ID 无效')
  })

  it.each(['docx', 'xlsx', 'pptx'] as const)('真实创建并重新解析 %s，没有外部运行时', async (format) => {
    const root = await ensureOfficeWorkspace('roundtrip')
    const tool = getOfficeToolDefinitions().find((item) => item.name === 'office_create_document')!
    const result = await tool.execute({ ...document, path: `outputs/report.${format}` }, { projectPath: root })
    expect(result.content).toContain('已创建并验证')
    const text = await extractOfficeFile(root, `outputs/report.${format}`)
    expect(text).toContain(format === 'xlsx' ? '研发' : format === 'pptx' ? '目标已完成' : '真实生成的报告')
    expect(await listOfficeFiles(root)).toMatchObject([{ role: 'output', format }])
    await expect(tool.execute({ ...document, path: `outputs/report.${format}` }, { projectPath: root })).rejects.toThrow()
  })

  it('PDF 使用无脚本沙箱打印并真实重新解析，输入被HTML转义且窗口清理', async () => {
    const buffer = await createOfficeDocument('pdf', { ...document, title: '<script>alert(1)</script>' })
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-')
    expect(await extractOfficeDocument(buffer, 'pdf')).toContain('Office report')
    expect(state.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(state.html).not.toContain('<script>')
    expect(state.options).toMatchObject({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, javascript: false } })
    expect(state.destroyed).toBe(true)
    expect(escapeOfficeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('拒绝符号链接、无效格式和将产物写入导入资料', async (ctx) => {
    if (!(await canSymlink())) { ctx.skip(); return }
    const root = await ensureOfficeWorkspace('safe-task')
    const outside = join(state.root, 'outside.docx')
    await writeFile(outside, 'outside')
    await symlink(outside, join(root, 'inputs', 'linked.docx'))
    await expect(resolveOfficeFile(root, 'inputs/linked.docx')).rejects.toThrow('普通办公文件')
    const tool = getOfficeToolDefinitions().find((item) => item.name === 'office_create_document')!
    await expect(tool.execute({ ...document, path: 'inputs/changed.docx' }, { projectPath: root })).rejects.toThrow('不能修改导入资料')
    await expect(extractOfficeDocument(Buffer.from('fake pdf'), 'pdf')).rejects.toThrow('有效的 PDF')
    expect(await listOfficeFiles(root)).toEqual([])
    await rm(join(root, 'outputs'), { recursive: true })
    const outsideDirectory = join(state.root, 'outside-dir')
    await mkdir(outsideDirectory)
    await symlink(outsideDirectory, join(root, 'outputs'))
    await expect(ensureOfficeWorkspace('safe-task')).rejects.toThrow('符号链接')
  })

  it('停止后不创建文档、不写入任何产物', async () => {
    const root = await ensureOfficeWorkspace('cancel-task')
    const controller = new AbortController()
    controller.abort()
    const tool = getOfficeToolDefinitions().find((item) => item.name === 'office_create_document')!
    await expect(tool.execute({ ...document, path: 'outputs/cancelled.docx' }, { projectPath: root, signal: controller.signal })).rejects.toThrow()
    expect(await listOfficeFiles(root)).toEqual([])
  })
})
