import { readFile } from 'node:fs/promises'
import type { ToolDefinition } from './index'
import { officeFormat, resolveOfficeFile } from '../office'
import { extractOfficeDocument } from '../officeDocuments'
import { writeOfficeOutput } from '../officeWrite'
import { calculateWorkbook } from '../officeFormulas'
import { editOfficeDocument, inspectOfficeDocument, type OfficeDocumentEdit } from '../officeEditing'
import { extractScannedPdf } from '../officeOcr'
import { summarizeFormulaReport } from '../officeFormulaReport'

const sourceBytes = async (root: string, path: unknown, signal?: AbortSignal): Promise<Buffer> => {
  if (typeof path !== 'string') throw new Error('缺少源文件路径')
  signal?.throwIfAborted()
  return readFile(await resolveOfficeFile(root, path), { signal })
}
const integer = (value: unknown, fallback: number, max: number): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback

export function getAdvancedOfficeToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'office_inspect_document',
      description: '检查 DOCX/PPTX/XLSX 原模板中可编辑的段落位置及工作表单元格。返回准确的 location/id、原文本或公式，供 office_edit_document 定点修改并保留排版；支持 offset/limit 分页。',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer', description: '默认80，最大200' } }, required: ['path'] },
      kind: 'read', timeoutMs: 120_000,
      async execute(input, ctx) {
        const format = officeFormat(String(input.path ?? ''))
        if (!['docx', 'pptx', 'xlsx'].includes(format)) throw new Error('模板检查支持 DOCX、PPTX、XLSX')
        const info = await inspectOfficeDocument(await sourceBytes(ctx.projectPath, input.path, ctx.signal), format as 'docx' | 'pptx' | 'xlsx', ctx.signal)
        const entries = [...info.textLocations.map((location) => ({ kind: 'text', ...location })), ...info.sheets.flatMap((sheet) => sheet.cells.map((cell) => ({ kind: 'cell', sheet: sheet.name, ...cell })))]
        const offset = integer(input.offset, 0, entries.length)
        const limit = Math.max(1, integer(input.limit, 80, 200))
        return { content: JSON.stringify({ format, signed: info.signed, total: entries.length, offset, nextOffset: offset + limit < entries.length ? offset + limit : null, locations: entries.slice(offset, offset + limit) }, null, 2) }
      },
    },
    {
      name: 'office_edit_document',
      description: '修改原模板的指定内容并另存 outputs/ 新副本。先用 office_inspect_document 获得位置。DOCX/PPTX 用{kind:"text",location,find,replacement}定点跨run替换；XLSX 用{kind:"cell",sheet,cell,value或formula}。保留未修改的样式/图片/页眉页脚/图表/合并单元格等parts；XLSX同时本地重算。匹配歧义、签名或不支持的结构明确拒绝；此工具不编辑PDF正文。',
      inputSchema: { type: 'object', properties: {
        sourcePath: { type: 'string', description: 'inputs/或outputs/源文件，不会覆盖' }, path: { type: 'string', description: 'outputs/新文件，扩展名与源文件相同' },
        edits: { type: 'array', items: { oneOf: [
          { type: 'object', properties: { kind: { const: 'text' }, location: { type: 'string' }, find: { type: 'string' }, replacement: { type: 'string' } }, required: ['kind', 'location', 'find', 'replacement'], additionalProperties: false },
          { type: 'object', properties: { kind: { const: 'cell' }, sheet: { type: 'string' }, cell: { type: 'string' }, value: { type: ['string', 'number', 'boolean', 'null'] }, formula: { type: 'string' } }, required: ['kind', 'sheet', 'cell'], additionalProperties: false },
        ] } },
      }, required: ['sourcePath', 'path', 'edits'] },
      requiresApproval: true, kind: 'edit', timeoutMs: 120_000,
      async execute(input, ctx) {
        const format = officeFormat(String(input.sourcePath ?? ''))
        const path = String(input.path ?? '')
        if (!['docx', 'pptx', 'xlsx'].includes(format) || officeFormat(path) !== format) throw new Error('源文件和结果必须是同格式 DOCX/PPTX/XLSX')
        await resolveOfficeFile(ctx.projectPath, path, true)
        if (!path.startsWith('outputs/')) throw new Error('修改结果必须另存到 outputs/')
        if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 200 || JSON.stringify(input.edits).length > 500_000) throw new Error('需要1–200项修改，总内容最多500000字符')
        const changed = await editOfficeDocument(await sourceBytes(ctx.projectPath, input.sourcePath, ctx.signal), format as 'docx' | 'pptx' | 'xlsx', input.edits as OfficeDocumentEdit[], ctx.signal)
        let buffer = changed.buffer
        let calculation = ''
        if (format === 'xlsx') {
          const result = await calculateWorkbook(buffer, ctx.signal)
          buffer = result.buffer
          calculation = `\n公式计算：${summarizeFormulaReport(result.report)}`
        }
        await extractOfficeDocument(buffer, format, ctx.signal)
        await writeOfficeOutput(ctx.projectPath, path, buffer, ctx.signal)
        return { content: `已修改并保留模板，另存：${path}\n${JSON.stringify(changed.changes)}${calculation}` }
      },
    },
    {
      name: 'office_calculate_spreadsheet',
      description: '本地重算现有 XLSX 公式，将原公式及计算结果保存到 outputs/ 新副本，保留原表格式/图表/其他内容。支持常用函数与跨工作表依赖；不支持外部引用、宏及部分Excel专用函数，明确列出未能计算的单元格，绝不返回旧缓存冒充结果。',
      inputSchema: { type: 'object', properties: { sourcePath: { type: 'string' }, path: { type: 'string', description: 'outputs/新文件.xlsx' } }, required: ['sourcePath', 'path'] },
      requiresApproval: true, kind: 'edit', timeoutMs: 120_000,
      async execute(input, ctx) {
        const path = String(input.path ?? '')
        if (officeFormat(String(input.sourcePath ?? '')) !== 'xlsx' || officeFormat(path) !== 'xlsx') throw new Error('公式计算仅支持XLSX文件')
        const result = await calculateWorkbook(await sourceBytes(ctx.projectPath, input.sourcePath, ctx.signal), ctx.signal)
        await extractOfficeDocument(result.buffer, 'xlsx', ctx.signal)
        await writeOfficeOutput(ctx.projectPath, path, result.buffer, ctx.signal)
        return { content: `已保存公式与实际计算结果：${path}\n${summarizeFormulaReport(result.report)}${result.report.unsupported.length || result.report.warnings.length ? '\n存在未支持公式、计算错误或警告，请向用户明确说明这些诊断。' : ''}` }
      },
    },
    {
      name: 'office_ocr_pdf',
      description: '在本机识别扫描PDF中文/英文文字，不上传文件。省略pages时保留原生文字，仅OCR无文字页（自动前10页，剩余页给出分页提示）；pages为1-based页码数组，指定时强制OCR最多30页。返回每页来源及OCR置信度，低置信度数字需用户复核。',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, pages: { type: 'array', items: { type: 'integer' }, maxItems: 30 }, languages: { type: 'array', items: { type: 'string', enum: ['chi_sim', 'eng'] }, description: '默认简体中文和英文' } }, required: ['path'] },
      kind: 'read', timeoutMs: 300_000,
      async execute(input, ctx) {
        if (officeFormat(String(input.path ?? '')) !== 'pdf') throw new Error('OCR目前支持PDF')
        const result = await extractScannedPdf(await sourceBytes(ctx.projectPath, input.path, ctx.signal), { pages: input.pages as number[] | undefined, languages: input.languages as string[] | undefined, signal: ctx.signal,
          onProgress: (progress) => ctx.onOutput?.(`OCR第${progress.page}页（${progress.completed}/${progress.total}） ${Math.round(progress.progress * 100)}%\n`),
        })
        return { content: `${result.text}\n${JSON.stringify({ totalPages: result.totalPages, ocrPages: result.ocrPages, nextPages: result.nextPages, truncated: result.truncated, confidence: result.pages.map((page) => ({ page: page.pageNumber, source: page.source, confidence: page.confidence })) })}` }
      },
    },
  ]
}
