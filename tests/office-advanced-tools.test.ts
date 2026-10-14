import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'

const fixture = vi.hoisted(() => ({ root: '', ocr: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root }, ipcMain: { handle: vi.fn() }, dialog: {}, shell: {}, safeStorage: {}, BrowserWindow: class {} }))
vi.mock('../src/main/officeFormulas', async () => ({ calculateWorkbook: (await import('../src/main/officeFormulaCore')).calculateWorkbookCore }))
vi.mock('../src/main/officeOcr', () => ({ extractScannedPdf: fixture.ocr }))
import { getOfficeToolDefinitions } from '../src/main/tools/office'
import { ensureOfficeWorkspace, extractOfficeFile } from '../src/main/office'
import { createOfficeDocument } from '../src/main/officeDocuments'

let root: string
beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'sw-office-advanced-'))
  root = await ensureOfficeWorkspace('advanced')
  fixture.ocr.mockReset().mockResolvedValue({ text: '扫描识别内容', totalPages: 1, pages: [{ pageNumber: 1, text: '扫描识别内容', source: 'ocr', confidence: 90 }], ocrPages: [1], nextPages: [], truncated: false })
})
afterEach(async () => { await rm(fixture.root, { recursive: true, force: true }) })
const tool = (name: string) => getOfficeToolDefinitions().find((item) => item.name === name)!

describe('办公增强工具真实文件接线', () => {
  it('新建公式单元格真实计算并在XLSX中保留公式和结果', async () => {
    const result = await tool('office_create_document').execute({ title: '费用', path: 'outputs/formulas.xlsx', sheets: [{ name: '费用', rows: [['金额', 10], ['金额', 20], ['合计', { formula: '=SUM(B1:B2)' }]] }] }, { projectPath: root })
    expect(result.content).toContain('公式实际计算')
    const book = new ExcelJS.Workbook()
    await book.xlsx.readFile(join(root, 'outputs/formulas.xlsx'))
    expect(book.worksheets[0].getCell('B3').value).toMatchObject({ formula: 'SUM(B1:B2)', result: 30 })
  })
  it('不支持的创建公式不写入产物，原有计算错误会明确报告', async () => {
    await expect(tool('office_create_document').execute({ title: '无效', path: 'outputs/unsupported.xlsx', sheets: [{ name: '数据', rows: [[{ formula: 'UNKNOWN_FUNCTION(1)' }]] }] }, { projectPath: root })).rejects.toThrow('公式未能计算')
    await expect(readFile(join(root, 'outputs/unsupported.xlsx'))).rejects.toThrow()
    const result = await tool('office_create_document').execute({ title: '错误', path: 'outputs/error.xlsx', sheets: [{ name: '数据', rows: [[{ formula: '1/0' }]] }] }, { projectPath: root })
    expect(result.content).toContain('#DIV/0!')
  })
  it('修改已有表格保留合并/样式，并重算依赖公式；原文件字节不变', async () => {
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('数据')
    sheet.getCell('A1').value = 4
    sheet.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } }
    sheet.getCell('B1').value = { formula: 'A1*2', result: 8 }
    sheet.mergeCells('C2:D2')
    const bytes = Buffer.from(await book.xlsx.writeBuffer())
    await writeFile(join(root, 'inputs/original.xlsx'), bytes)
    const inspected = await tool('office_inspect_document').execute({ path: 'inputs/original.xlsx' }, { projectPath: root })
    expect(JSON.parse(inspected.content).locations).toContainEqual(expect.objectContaining({ sheet: '数据', address: 'A1' }))
    const result = await tool('office_edit_document').execute({ sourcePath: 'inputs/original.xlsx', path: 'outputs/edited.xlsx', edits: [{ kind: 'cell', sheet: '数据', cell: 'A1', value: 7 }] }, { projectPath: root })
    expect(result.content).toContain('公式计算')
    const read = new ExcelJS.Workbook()
    await read.xlsx.readFile(join(root, 'outputs/edited.xlsx'))
    expect(read.worksheets[0].getCell('A1').font).toMatchObject({ bold: true })
    expect(read.worksheets[0].getCell('B1').value).toMatchObject({ formula: 'A1*2', result: 14 })
    expect(read.worksheets[0].getCell('D2').master.address).toBe('C2')
    expect(await readFile(join(root, 'inputs/original.xlsx'))).toEqual(bytes)
    const before = await JSZip.loadAsync(bytes), after = await JSZip.loadAsync(await readFile(join(root, 'outputs/edited.xlsx')))
    expect(await after.file('xl/styles.xml')!.async('nodebuffer')).toEqual(await before.file('xl/styles.xml')!.async('nodebuffer'))
  })
  it('Word原模板定点替换写新副本，并拒绝覆盖原件/已有文件', async () => {
    const bytes = await createOfficeDocument('docx', { title: '原标题', paragraphs: ['原项目名称'], sheets: [], slides: [] })
    await writeFile(join(root, 'inputs/template.docx'), bytes)
    const inspected = JSON.parse((await tool('office_inspect_document').execute({ path: 'inputs/template.docx' }, { projectPath: root })).content)
    const location = inspected.locations.find((entry: { text?: string }) => entry.text === '原项目名称').id
    const args = { sourcePath: 'inputs/template.docx', path: 'outputs/edited.docx', edits: [{ kind: 'text', location, find: '原项目名称', replacement: '新项目名称' }] }
    await tool('office_edit_document').execute(args, { projectPath: root })
    expect(await extractOfficeFile(root, 'outputs/edited.docx')).toContain('新项目名称')
    expect(await readFile(join(root, 'inputs/template.docx'))).toEqual(bytes)
    await expect(tool('office_edit_document').execute(args, { projectPath: root })).rejects.toThrow()
    await expect(tool('office_edit_document').execute({ ...args, path: 'inputs/template.docx' }, { projectPath: root })).rejects.toThrow('另存')
  })
  it('PDF读工具自动走本地识别，显式OCR带页码与置信度', async () => {
    await writeFile(join(root, 'inputs/scan.pdf'), '%PDF-fixture')
    expect((await tool('office_read_document').execute({ path: 'inputs/scan.pdf' }, { projectPath: root })).content).toContain('扫描识别内容')
    const result = await tool('office_ocr_pdf').execute({ path: 'inputs/scan.pdf', pages: [1], languages: ['chi_sim'] }, { projectPath: root })
    expect(fixture.ocr).toHaveBeenLastCalledWith(expect.any(Buffer), expect.objectContaining({ pages: [1], languages: ['chi_sim'] }))
    expect(result.content).toContain('confidence')
  })
})
