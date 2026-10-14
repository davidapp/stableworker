import type { ToolDefinition } from './index'
import { createOfficeDocument, type OfficeCell, type OfficeDocumentInput } from '../officeDocuments'
import { extractOfficeFile, listOfficeFiles, officeFormat, resolveOfficeFile } from '../office'
import { writeOfficeOutput } from '../officeWrite'
import { getAdvancedOfficeToolDefinitions } from './officeAdvanced'
import { extractScannedPdf } from '../officeOcr'
import { readFile } from 'node:fs/promises'
import type { FormulaCalculationReport } from '../officeFormulas'
import { summarizeFormulaReport } from '../officeFormulaReport'

function parseDocumentInput(input: Record<string, unknown>): OfficeDocumentInput {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title || title.length > 500) throw new Error('title 必须为 1–500 字符')
  const texts = (value: unknown, limit: number): string[] => {
    if (!Array.isArray(value) || value.length > limit || value.some((v) => typeof v !== 'string')) throw new Error('文本列表无效或过长')
    return value as string[]
  }
  const paragraphs = input.paragraphs == null ? [] : texts(input.paragraphs, 2000)
  const sheets: OfficeDocumentInput['sheets'] = []
  if (input.sheets != null) {
    if (!Array.isArray(input.sheets) || input.sheets.length > 20) throw new Error('工作表列表无效，最多 20 个')
    for (const value of input.sheets) {
      const spec = value as Record<string, unknown>
      if (!spec || typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 31 || /[\\/*?:\[\]]/.test(spec.name)) throw new Error('工作表名称无效')
      if (!Array.isArray(spec.rows) || spec.rows.length > 5000) throw new Error('每个工作表最多 5000 行')
      const rows = spec.rows.map((row) => {
        if (!Array.isArray(row) || row.length > 100) throw new Error('每行最多 100 列')
        for (const value of row) {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (typeof value.formula !== 'string' || !value.formula.trim() || value.formula.length > 8192 || Object.keys(value).some((key) => key !== 'formula')) throw new Error('公式单元格必须是 {formula:有效公式}，最多 8192 字符')
          } else if (value !== null && (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) throw new Error('单元格只能是文字、数字、布尔值、null 或 {formula:公式}')
        }
        return row as OfficeCell[]
      })
      sheets.push({ name: spec.name, rows })
    }
  }
  const slides: OfficeDocumentInput['slides'] = []
  if (input.slides != null) {
    if (!Array.isArray(input.slides) || input.slides.length > 100) throw new Error('幻灯片列表无效，最多 100 页')
    for (const value of input.slides) {
      const spec = value as Record<string, unknown>
      if (!spec || typeof spec.title !== 'string' || spec.title.length > 500) throw new Error('幻灯片标题无效')
      slides.push({ title: spec.title, bullets: texts(spec.bullets ?? [], 30), notes: typeof spec.notes === 'string' ? spec.notes : undefined })
    }
  }
  if (JSON.stringify({ title, paragraphs, sheets, slides }).length > 500_000) throw new Error('文档内容超过 500000 字符上限')
  return { title, paragraphs, sheets, slides }
}

export function getOfficeToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'office_read_document',
      description: '读取当前办公任务 inputs/ 或 outputs/ 中的 DOCX、XLSX、PPTX、PDF、TXT、Markdown、CSV。PDF 自动保留原生文字并本地识别无文字扫描页；超过自动批次用 office_ocr_pdf 分页。XLSX 可另用 office_calculate_spreadsheet 重算公式。',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: '任务内相对路径，例如 inputs/abc-资料.docx' }, offset: { type: 'integer', description: '提取文字的起始字符，从 0 开始，分段阅读长文档' }, limit: { type: 'integer', description: '最多返回字符数，默认及最大 18000' } }, required: ['path'] },
      kind: 'read', timeoutMs: 300_000,
      async execute(input, ctx) {
        ctx.signal?.throwIfAborted()
        const path = String(input.path ?? '')
        const text = officeFormat(path) === 'pdf'
          ? (await extractScannedPdf(await readFile(await resolveOfficeFile(ctx.projectPath, path), { signal: ctx.signal }), { signal: ctx.signal,
            onProgress: (progress) => ctx.onOutput?.(`识别第 ${progress.page} 页（${progress.completed}/${progress.total}） ${Math.round(progress.progress * 100)}%\n`),
          })).text
          : await extractOfficeFile(ctx.projectPath, path, ctx.signal)
        const offset = Math.max(0, Math.floor(typeof input.offset === 'number' ? input.offset : 0))
        const limit = Math.max(1, Math.min(18_000, Math.floor(typeof input.limit === 'number' ? input.limit : 18_000)))
        return { content: `${text.slice(offset, offset + limit)}\n（已提取 ${text.length} 字符；当前 ${offset}–${Math.min(offset + limit, text.length)}${offset + limit < text.length ? '，可用 offset 继续读取' : ''}）` }
      },
    },
    {
      name: 'office_create_document',
      description: '创建真正的 DOCX、XLSX、PPTX 或 PDF 文件到 outputs/<文件名>。DOCX/PDF 用 title+paragraphs；XLSX 用 sheets{name,rows}，单元格可为文字/数字/布尔值/null 或 {formula:"SUM(B2:B5)"}，本地计算并保存公式及结果。PPTX 用 slides{title,bullets,notes}。重新解析验证；已有文件不覆盖。修改模板用 office_inspect_document 和 office_edit_document。',
      inputSchema: { type: 'object', properties: {
        path: { type: 'string', description: '必须是 outputs/ 下新文件名，例如 outputs/报告.docx；格式由扩展名确定' },
        title: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } },
        sheets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: { oneOf: [{ type: ['string', 'number', 'boolean', 'null'] }, { type: 'object', properties: { formula: { type: 'string', description: 'Excel公式，可省略开头=' } }, required: ['formula'], additionalProperties: false }] } } } }, required: ['name', 'rows'] } },
        slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['title', 'bullets'] } },
      }, required: ['path', 'title'] },
      requiresApproval: true, kind: 'edit', timeoutMs: 120_000,
      async execute(input, ctx) {
        ctx.signal?.throwIfAborted()
        const path = String(input.path ?? '')
        if (!path.startsWith('outputs/')) throw new Error('产物必须写入 outputs/，不能修改导入资料')
        const format = officeFormat(path)
        if (!['docx', 'xlsx', 'pptx', 'pdf'].includes(format)) throw new Error('创建工具支持 DOCX、XLSX、PPTX、PDF')
        await resolveOfficeFile(ctx.projectPath, path, true)
        const spec = parseDocumentInput(input)
        if (format === 'xlsx' && spec.sheets.length === 0) throw new Error('XLSX 至少需要一个工作表')
        if (format === 'pptx' && spec.slides.length === 0) throw new Error('PPTX 至少需要一页幻灯片')
        let formulaReport: FormulaCalculationReport | undefined
        const buffer = await createOfficeDocument(format, spec, ctx.signal, (report) => { formulaReport = report })
        await writeOfficeOutput(ctx.projectPath, path, buffer, ctx.signal)
        return { content: `已创建并验证：${path}（${buffer.length} 字节，${format.toUpperCase()}）。可在办公产物面板预览或用本地应用打开。${formulaReport ? `\n公式实际计算：${summarizeFormulaReport(formulaReport)}${formulaReport.warnings.length ? '；有计算错误或警告，请向用户说明。' : ''}` : ''}` }
      },
    },
    {
      name: 'office_list_artifacts', description: '列出本办公任务已导入的资料和已生成的产物，包含相对路径、格式和字节大小。',
      inputSchema: { type: 'object', properties: {}, required: [] }, kind: 'read',
      async execute(_input, ctx) { ctx.signal?.throwIfAborted(); return { content: JSON.stringify(await listOfficeFiles(ctx.projectPath), null, 2) } },
    },
    ...getAdvancedOfficeToolDefinitions(),
  ]
}
