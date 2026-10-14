import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import FormulaParser, { type FormulaReference } from 'fast-formula-parser'

export interface FormulaCalculationReport {
  calculated: number
  unsupported: string[]
  warnings: string[]
}
export interface FormulaCalculationResult { buffer: Buffer; report: FormulaCalculationReport }

const MAX_CELLS = 100_000
const MAX_FORMULAS = 10_000
const MAX_RANGE_CELLS = 100_000
const MAX_EDGES = 200_000
const MAX_DEPTH = 256
const MAX_ROW = 1_048_576
const MAX_COLUMN = 16_384
const supportedFunctions = new Set(['SUM', 'AVERAGE', 'IF', 'COUNTIF', 'SUMIF', 'COUNT', 'COUNTA', 'COUNTBLANK', 'MIN', 'MAX', 'IFERROR', 'IFNA', 'AND', 'OR', 'NOT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS', 'INT', 'MOD', 'POWER', 'SQRT', 'SUMPRODUCT', 'SUMSQ', 'PRODUCT', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS', 'LEFT', 'RIGHT', 'MID', 'LEN', 'TRIM', 'UPPER', 'LOWER', 'CONCAT', 'CONCATENATE', 'TRUE', 'FALSE', 'ISNUMBER', 'ISTEXT', 'ISERROR', 'ISBLANK', 'NA', 'VLOOKUP', 'HLOOKUP', 'INDEX', 'AVERAGEIF'])
const allowedErrors = new Set(['#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!'])
type Value = string | number | boolean | null | InstanceType<typeof FormulaParser.FormulaError>
interface Cell { address: string; row: number; col: number; value: Value; formula?: string; kind?: string; shared?: string; raw: string; result?: Value; unsupported?: string; unsupportedRef?: string; discardCache?: boolean }
interface Sheet { name: string; path: string; xml: string; cells: Map<string, Cell> }
const cellPattern = /<(?:[^\s<>/:]+:)?c\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:[^\s<>/:]+:)?c\s*>)/g

function escapeXml(text: string): string { return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!) }
function columnNumber(text: string): number { return [...text.toUpperCase()].reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0) }
function columnName(number: number): string { let text = ''; while (number > 0) { number--; text = String.fromCharCode(65 + number % 26) + text; number = Math.floor(number / 26) } return text }
function address(row: number, col: number): string { return `${columnName(col)}${row}` }
function parseAddress(text: string): { row: number; col: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(text)
  if (!match) return null
  const row = Number(match[2]), col = columnNumber(match[1])
  return row <= MAX_ROW && col <= MAX_COLUMN ? { row, col } : null
}
function textValue(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (value && typeof value === 'object' && '#text' in value) return String((value as Record<string, unknown>)['#text'] ?? ''); return '' }
function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value] }
function richText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(richText).join('')
  return Object.entries(value).map(([key, item]) => key === 't' ? textValue(item) : richText(item)).join('')
}

function formulaArgument(arg: unknown): unknown {
  return arg && typeof arg === 'object' && !Array.isArray(arg) && 'value' in arg ? (arg as { value: unknown }).value : arg
}

function numericArgument(arg: unknown): number {
  let value = formulaArgument(arg)
  if (Array.isArray(value)) {
    if (value.length !== 1 || !Array.isArray(value[0]) || value[0].length !== 1) throw FormulaParser.FormulaError.VALUE
    value = value[0][0]
  }
  if (value instanceof FormulaParser.FormulaError) throw value
  if (value === null) return 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return 0
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) throw FormulaParser.FormulaError.VALUE
    value = Number(text)
  }
  if (typeof value !== 'number') throw FormulaParser.FormulaError.VALUE
  if (!Number.isFinite(value)) throw FormulaParser.FormulaError.NUM
  return value
}

/** Round the decimal representation, using integer quotient/remainder instead of binary scaling. */
function decimalRound(args: unknown[], mode: 'nearest' | 'up' | 'down'): number {
  if (args.length !== 2) throw FormulaParser.FormulaError.VALUE
  const value = numericArgument(args[0]), rawDigits = numericArgument(args[1])
  const digits = Math.trunc(rawDigits)
  if (digits < -308 || digits > 308) throw FormulaParser.FormulaError.NUM
  if (value === 0) return 0
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(Math.abs(value).toString())!
  const fraction = match[2] ?? '', coefficient = BigInt(match[1] + fraction)
  const shift = Number(match[3] ?? 0) - fraction.length + digits
  let units: bigint
  if (shift >= 0) units = coefficient * 10n ** BigInt(shift)
  else {
    const divisor = 10n ** BigInt(-shift), remainder = coefficient % divisor
    units = coefficient / divisor
    if ((mode === 'nearest' && remainder * 2n >= divisor) || (mode === 'up' && remainder !== 0n)) units++
  }
  const rounded = Number(`${value < 0 ? '-' : ''}${units}e${-digits}`)
  if (!Number.isFinite(rounded)) throw FormulaParser.FormulaError.NUM
  return rounded === 0 ? 0 : rounded
}

function countBlank(args: unknown[]): number {
  if (args.length !== 1) throw FormulaParser.FormulaError.VALUE
  const arg = args[0] as { isCellRef?: boolean; isRangeRef?: boolean } | null
  if (!arg || (!arg.isCellRef && !arg.isRangeRef)) throw FormulaParser.FormulaError.VALUE
  let count = 0
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value === null || value === undefined || value === '') count++
  }
  visit(formulaArgument(arg))
  return count
}

const formulaOverrides = {
  ROUND: (...args: unknown[]) => decimalRound(args, 'nearest'),
  ROUNDUP: (...args: unknown[]) => decimalRound(args, 'up'),
  ROUNDDOWN: (...args: unknown[]) => decimalRound(args, 'down'),
  COUNTBLANK: (...args: unknown[]) => countBlank(args),
}
function maskQuoted(formula: string): string {
  let out = '', quote = ''
  for (let i = 0; i < formula.length; i++) {
    const char = formula[i]
    if (quote) { out += ' '; if (char === quote) { if (formula[i + 1] === quote) { out += ' '; i++ } else quote = '' } }
    else if (char === '"' || char === "'") { quote = char; out += ' ' }
    else out += char
  }
  return out
}
function translateShared(formula: string, source: Cell, target: Cell): string {
  const mask = maskQuoted(formula)
  const matches = [...mask.matchAll(/(?<![\w.])(?<absCol>\$?)(?<col>[A-Z]{1,3})(?<absRow>\$?)(?<row>[1-9]\d*)(?![\w])/gi)]
  let out = formula
  for (const match of matches.reverse()) {
    const start = match.index!, next = mask.slice(start + match[0].length).trimStart()[0]
    if (next === '!' || next === '(') continue
    const groups = match.groups!, row = Number(groups.row) + (groups.absRow ? 0 : target.row - source.row), col = columnNumber(groups.col) + (groups.absCol ? 0 : target.col - source.col)
    const replacement = row < 1 || row > MAX_ROW || col < 1 || col > MAX_COLUMN ? '#REF!' : `${groups.absCol}${columnName(col)}${groups.absRow}${row}`
    out = out.slice(0, start) + replacement + out.slice(start + match[0].length)
  }
  return out
}

/** Only formula cache/type is changed. Original formula, cell attributes and every other XML part remain intact. */
function cacheCell(raw: string, value: Value): string {
  const open = /^<([^\s<>/:]+:)?c\b([^>]*?)(\/?)>/.exec(raw)!
  const prefix = open[1] ?? ''
  const isError = value instanceof FormulaParser.FormulaError
  const type = isError ? 'e' : typeof value === 'boolean' ? 'b' : typeof value === 'string' ? 'str' : ''
  let attrs = open[2].replace(/\s+t\s*=\s*("[^"]*"|'[^']*')/g, '')
  if (type) attrs += ` t="${type}"`
  const encoded = isError ? value.error : typeof value === 'boolean' ? (value ? '1' : '0') : value === null ? '0' : String(value)
  let inner = open[3] ? '' : raw.slice(open[0].length).replace(/<\/([^\s<>/:]+:)?c\s*>$/, '')
  inner = inner.replace(/<(?:[^\s<>/:]+:)?v\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:[^\s<>/:]+:)?v\s*>)/g, '').replace(/<(?:[^\s<>/:]+:)?is\b[^>]*>[\s\S]*?<\/(?:[^\s<>/:]+:)?is\s*>/g, '')
  // v belongs immediately after f (before extLst), rather than at the end of the cell.
  const cached = `<${prefix}v>${escapeXml(encoded)}</${prefix}v>`
  const formula = /<(?:[^\s<>/:]+:)?f\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:[^\s<>/:]+:)?f\s*>)/.exec(inner)
  if (formula) { const end = formula.index + formula[0].length; inner = inner.slice(0, end) + cached + inner.slice(end) }
  else inner = cached + inner
  return `<${prefix}c${attrs}>${inner}</${prefix}c>`
}

/** Pure computation used inside the worker and by semantic tests. Host code should use calculateWorkbook. */
export async function calculateWorkbookCore(buffer: Buffer, signal?: AbortSignal): Promise<FormulaCalculationResult> {
  const check = (): void => signal?.throwIfAborted()
  check()
  if (buffer.length > 25 * 1024 * 1024) throw new Error('工作簿超过 25 MB 上限')
  const zip = await JSZip.loadAsync(buffer)
  const entries = Object.values(zip.files)
  if (entries.some((entry) => /(^|\/)_xmlsignatures\//i.test(entry.name))) throw new Error('工作簿包含数字签名，拒绝修改公式缓存，以免破坏签名')
  if (entries.length > 10_000) throw new Error('工作簿 ZIP 条目过多')
  let unpacked = 0
  for (const entry of entries) { unpacked += (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0 }
  if (unpacked > 100 * 1024 * 1024) throw new Error('工作簿解压后超过 100 MB 上限')
  const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: false })
  const xml = async (path: string): Promise<string> => { check(); const file = zip.file(path); if (!file) throw new Error(`工作簿缺少 ${path}`); const text = await file.async('string'); if (/<!DOCTYPE/i.test(text)) throw new Error('工作簿不允许 DTD'); return text }
  const workbook = xmlParser.parse(await xml('xl/workbook.xml')).workbook
  if (!workbook) throw new Error('不是有效 XLSX 工作簿')
  const relations = list<Record<string, string>>(xmlParser.parse(await xml('xl/_rels/workbook.xml.rels')).Relationships?.Relationship)
  const relationshipMap = new Map(relations.filter((item) => item['@_TargetMode'] !== 'External').map((item) => [item['@_Id'], item['@_Target']]))
  const sharedStrings = zip.file('xl/sharedStrings.xml') ? list(xmlParser.parse(await xml('xl/sharedStrings.xml')).sst?.si).map(richText) : []
  const sheets: Sheet[] = []
  let cellsCount = 0, formulasCount = 0
  for (const spec of list<Record<string, string>>(workbook.sheets?.sheet)) {
    const target = relationshipMap.get(spec['@_id'])
    if (!target || target.includes('..') || target.includes('\\')) throw new Error('工作表关系路径无效')
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`
    const sheet: Sheet = { name: spec['@_name'], path, xml: await xml(path), cells: new Map() }
    const masters = new Map<string, Cell>()
    for (const match of sheet.xml.matchAll(cellPattern)) {
      if (++cellsCount > MAX_CELLS) throw new Error(`工作簿超过 ${MAX_CELLS} 个单元格上限`)
      const parsed = xmlParser.parse(match[0]).c as Record<string, unknown>
      const position = parseAddress(String(parsed['@_r'] ?? ''))
      if (!position) throw new Error('工作簿包含无效单元格地址')
      const type = parsed['@_t'], rawValue = textValue(parsed.v)
      let value: Value = null
      if (type === 's') value = sharedStrings[Number(rawValue)] ?? ''
      else if (type === 'inlineStr') value = richText(parsed.is)
      else if (type === 'str') value = rawValue
      else if (type === 'b') value = rawValue === '1'
      else if (type === 'e') value = new FormulaParser.FormulaError(rawValue)
      else if (rawValue !== '') value = Number.isFinite(Number(rawValue)) ? Number(rawValue) : rawValue
      const cell: Cell = { address: address(position.row, position.col), ...position, value, raw: match[0] }
      if ('f' in parsed) {
        if (++formulasCount > MAX_FORMULAS) throw new Error(`工作簿超过 ${MAX_FORMULAS} 个公式上限`)
        cell.formula = textValue(parsed.f).replace(/^=/, '')
        const formula = parsed.f && typeof parsed.f === 'object' ? parsed.f as Record<string, unknown> : {}
        cell.kind = String(formula['@_t'] ?? '')
        cell.shared = formula['@_si'] === undefined ? undefined : String(formula['@_si'])
        if (cell.kind === 'shared' && cell.formula && cell.shared !== undefined) masters.set(cell.shared, cell)
        if (cell.kind && !['normal', 'shared'].includes(cell.kind)) cell.unsupported = `${cell.kind} 数组/数据表公式暂不支持`
        if (cell.unsupported && typeof formula['@_ref'] === 'string') cell.unsupportedRef = formula['@_ref']
      }
      sheet.cells.set(cell.address, cell)
    }
    for (const cell of sheet.cells.values()) if (cell.kind === 'shared' && !cell.formula) {
      const master = cell.shared === undefined ? undefined : masters.get(cell.shared)
      if (!master?.formula) cell.unsupported = '共享公式缺少主单元格'
      else cell.formula = translateShared(master.formula, master, cell)
    }
    // Legacy array/data-table formulas can leave cached spill cells without an f tag.
    // Invalidate those too, so dependent formulas never consume their old numbers.
    for (const cell of sheet.cells.values()) if (cell.unsupportedRef) {
      const parts = cell.unsupportedRef.split(':'), from = parseAddress(parts[0]), to = parseAddress(parts[1] ?? parts[0])
      if (!from || !to || (to.row - from.row + 1) * (to.col - from.col + 1) > MAX_RANGE_CELLS) throw new Error('不支持的数组/数据表公式缓存范围过大，拒绝修改')
      for (const follower of sheet.cells.values()) if (follower !== cell && follower.row >= from.row && follower.row <= to.row && follower.col >= from.col && follower.col <= to.col) {
        follower.discardCache = true
        follower.result = FormulaParser.FormulaError.NAME
      }
    }
    sheets.push(sheet)
  }
  const byName = new Map(sheets.map((sheet) => [sheet.name.toLocaleLowerCase(), sheet]))
  const getSheet = (name: string | undefined, fallback?: string): Sheet => { const sheet = byName.get((name ?? fallback ?? '').toLocaleLowerCase()); if (!sheet) throw FormulaParser.FormulaError.REF; return sheet }
  const defined = list<Record<string, unknown>>(workbook.definedNames?.definedName)
  const variable = (name: string, sheetName?: string): FormulaReference | null => {
    const sheetIndex = sheets.findIndex((sheet) => sheet.name === sheetName)
    const spec = defined.find((item) => String(item['@_name']).toLowerCase() === name.toLowerCase() && String(item['@_localSheetId']) === String(sheetIndex)) ?? defined.find((item) => String(item['@_name']).toLowerCase() === name.toLowerCase() && item['@_localSheetId'] === undefined)
    if (!spec) return null
    const ref = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?(\$?[A-Z]{1,3}\$?[1-9]\d*)(?::(\$?[A-Z]{1,3}\$?[1-9]\d*))?$/i.exec(textValue(spec))
    if (!ref) return null
    const from = parseAddress(ref[3]), to = ref[4] ? parseAddress(ref[4]) : null
    if (!from) return null
    const sheet = (ref[1]?.replace(/''/g, "'") ?? ref[2] ?? sheetName)!
    return to ? { sheet, from, to } : { sheet, ...from }
  }
  const report: FormulaCalculationReport = { calculated: 0, unsupported: [], warnings: [] }
  const formulas = new Map<string, { sheet: Sheet; cell: Cell; deps: Set<string> }>()
  const key = (sheet: Sheet, cell: Cell): string => `${sheet.name}!${cell.address}`
  for (const sheet of sheets) for (const cell of sheet.cells.values()) if (cell.formula !== undefined) formulas.set(key(sheet, cell), { sheet, cell, deps: new Set() })
  const unsupported = (label: string, cell: Cell, reason: string): void => { cell.unsupported = reason; cell.result = FormulaParser.FormulaError.NAME; report.unsupported.push(`${label}: ${reason}`) }
  const refs = (ref: FormulaReference, fallback: string): { sheet: Sheet; positions: { row: number; col: number }[] } => {
    const sheet = getSheet(ref.sheet, fallback)
    const from = ref.from ?? { row: ref.row!, col: ref.col! }, to = ref.to ?? from
    if (![from.row, from.col, to.row, to.col].every(Number.isSafeInteger) || from.row < 1 || from.col < 1 || to.row > MAX_ROW || to.col > MAX_COLUMN || to.row < from.row || to.col < from.col) throw FormulaParser.FormulaError.REF
    if ((to.row - from.row + 1) * (to.col - from.col + 1) > MAX_RANGE_CELLS) throw new Error(`范围超过 ${MAX_RANGE_CELLS} 个单元格，不使用旧缓存`)
    const positions: { row: number; col: number }[] = []
    for (let row = from.row; row <= to.row; row++) for (let col = from.col; col <= to.col; col++) positions.push({ row, col })
    return { sheet, positions }
  }
  const depParser = new FormulaParser.DepParser({ onVariable: variable })
  let edges = 0
  for (const [label, item] of formulas) {
    check()
    const { cell, sheet, deps } = item
    if (cell.unsupported) { unsupported(label, cell, cell.unsupported); continue }
    const formula = cell.formula!
    const masked = maskQuoted(formula)
    const functions = [...masked.matchAll(/\b((?:_xlfn\.)?[A-Z][A-Z0-9_.]*)\s*\(/gi)].map((match) => match[1].toUpperCase().replace(/^_XLFN\./, ''))
    const unknown = functions.find((name) => !supportedFunctions.has(name))
    if (unknown || /\[|\]|\|/.test(masked) || formula.length > 8192) { unsupported(label, cell, unknown ? `函数 ${unknown} 暂不支持` : '外部/结构化引用或公式长度暂不支持'); continue }
    try {
      for (const ref of depParser.parse(formula, { sheet: sheet.name, row: cell.row, col: cell.col })) for (const position of refs(ref, sheet.name).positions) {
        if (++edges > MAX_EDGES) throw new Error(`依赖范围超过 ${MAX_EDGES} 个单元格上限`)
        const otherSheet = getSheet(ref.sheet, sheet.name), other = otherSheet.cells.get(address(position.row, position.col))
        if (other?.formula !== undefined) deps.add(key(otherSheet, other))
      }
    } catch (error) { unsupported(label, cell, error instanceof Error ? error.message || error.name : String(error)) }
  }
  const state = new Map<string, 'visiting' | 'done'>(), stack: string[] = []
  const getValue = (ref: FormulaReference): Value => {
    const sheet = getSheet(ref.sheet)
    const cell = sheet.cells.get(address(ref.row!, ref.col!))
    // SUMIF can expand a one-cell sum_range beyond its static reference.
    // Resolve newly encountered formula dependencies with a separate parser per active depth.
    if (cell?.formula !== undefined && cell.result === undefined) evaluate(key(sheet, cell))
    return cell?.formula !== undefined || cell?.discardCache ? cell.result ?? FormulaParser.FormulaError.REF : cell?.value ?? null
  }
  const parserOptions = { functions: formulaOverrides, onVariable: variable, onCell: getValue, onRange(ref: FormulaReference) {
    const range = refs(ref, ref.sheet!)
    const values: unknown[][] = []
    let previousRow = -1
    for (const position of range.positions) {
      if (previousRow !== position.row) { values.push([]); previousRow = position.row }
      values[values.length - 1].push(getValue({ sheet: range.sheet.name, ...position }))
    }
    return values
  } }
  const parsers = new Map<number, FormulaParser>()
  const evaluate = (label: string): void => {
    check()
    if (state.get(label) === 'done') return
    if (state.get(label) === 'visiting') {
      const cycle = stack.slice(stack.indexOf(label))
      for (const member of cycle) formulas.get(member)!.cell.result = FormulaParser.FormulaError.REF
      report.warnings.push(`循环依赖：${cycle.join(' → ')} → ${label}；缓存写入 #REF!`)
      return
    }
    const { sheet, cell, deps } = formulas.get(label)!
    if (cell.unsupported) { state.set(label, 'done'); return }
    if (stack.length >= MAX_DEPTH) { cell.result = FormulaParser.FormulaError.REF; report.warnings.push(`${label}: 公式依赖深度超过 ${MAX_DEPTH}`); state.set(label, 'done'); return }
    state.set(label, 'visiting'); stack.push(label)
    for (const dependency of deps) evaluate(dependency)
    if (cell.result === undefined) {
      try {
        let parser = parsers.get(stack.length)
        if (!parser) { parser = new FormulaParser(parserOptions); parsers.set(stack.length, parser) }
        const result = parser.parse(cell.formula!, { sheet: sheet.name, row: cell.row, col: cell.col })
        // A dynamically expanded dependency can diagnose a cycle during parse.
        // Do not overwrite that #REF! with a scalar from an unselected criteria branch.
        if (cell.result === undefined) {
          if (result instanceof FormulaParser.FormulaError) { cell.result = allowedErrors.has(result.error) ? result : FormulaParser.FormulaError.VALUE; report.warnings.push(`${label}: ${result.error}`) }
          else if (result === null || ['string', 'number', 'boolean'].includes(typeof result)) { cell.result = result as Value; report.calculated++ }
          else unsupported(label, cell, '数组或非标量公式结果暂不支持')
        }
      } catch (error) { check(); cell.result = FormulaParser.FormulaError.VALUE; report.warnings.push(`${label}: ${error instanceof Error ? error.message || error.name : String(error)}`) }
    }
    stack.pop(); state.set(label, 'done')
  }
  for (const label of formulas.keys()) evaluate(label)
  for (const sheet of sheets) {
    let changed = false
    const updated = sheet.xml.replace(cellPattern, (raw) => {
      const parsed = xmlParser.parse(raw).c
      const cell = sheet.cells.get(String(parsed['@_r']).toUpperCase())
      if (!cell || (cell.formula === undefined && !cell.discardCache)) return raw
      changed = true
      return cacheCell(raw, cell.result ?? FormulaParser.FormulaError.VALUE)
    })
    if (changed) zip.file(sheet.path, updated)
  }
  check()
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), report }
}
