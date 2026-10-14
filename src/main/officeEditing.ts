import { posix } from 'node:path'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'

export type EditableOfficeFormat = 'docx' | 'pptx' | 'xlsx'
export interface OfficeTextChange {
  kind: 'text'
  location: string
  find: string
  replacement: string
}
export type OfficeCellChange = { kind: 'cell'; sheet: string; cell: string } & (
  { value: string | number | boolean | null; formula?: never } |
  { formula: string; value?: never }
)
export type OfficeDocumentEdit = OfficeTextChange | OfficeCellChange
export interface OfficeChangeReport {
  kind: 'text' | 'cell'
  location: string
  before: string | number | boolean | null
  after: string | number | boolean | null
}
export interface OfficeTextLocation {
  id: string
  part: string
  paragraphIndex: number
  text: string
  editable: boolean
  reason?: string
}
export interface OfficeCellLocation {
  address: string
  type: string
  value: string | number | boolean | null
  formula?: string
  editable: boolean
  reason?: string
}
export interface OfficeInspection {
  format: EditableOfficeFormat
  signed: boolean
  textLocations: OfficeTextLocation[]
  sheets: { name: string; part: string; cells: OfficeCellLocation[]; editable: boolean; reason?: string }[]
}
export interface OfficeEditResult {
  buffer: Buffer
  changes: OfficeChangeReport[]
}

const W = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])
const A = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'])
const S = new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'])
const P = new Set(['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'])
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024
const MAX_XML_PART_BYTES = 20 * 1024 * 1024
const MAX_ELEMENTS = 250_000

interface XmlElement {
  name: string
  local: string
  namespace: string
  namespaces: Record<string, string>
  attributes: Record<string, string>
  start: number
  openEnd: number
  closeStart: number
  end: number
  selfClosing: boolean
  parent?: XmlElement
  children: XmlElement[]
}
interface XmlPart { name: string; xml: string; elements: XmlElement[] }
interface TextSegment { element: XmlElement; text: string; start: number; end: number }
interface Paragraph { location: OfficeTextLocation; element: XmlElement; segments: TextSegment[] }
interface Sheet { name: string; part: XmlPart; cells: XmlElement[]; strings: { text: string; element: XmlElement; part: XmlPart }[]; blocked: { first: string; last: string; reason: string }[]; reason?: string }
interface DocumentPackage { zip: JSZip; signed: boolean; format: EditableOfficeFormat; parts: Map<string, XmlPart>; paragraphs: Map<string, Paragraph>; sheets: Sheet[] }
interface Patch { start: number; end: number; text: string }
interface TextReplacement { start: number; length: number; replacement: string }

function xmlText(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (match, hex: string, decimal: string, named: string) => {
    if (hex || decimal) return String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10))
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[named] ?? match
  })
}

function escapeXml(value: string): string {
  for (const char of value) {
    const cp = char.codePointAt(0)!
    if (!(cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff))) {
      throw new Error('替换内容包含 XML 不支持的字符')
    }
  }
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)
}

/** Positions reference the original XML: only selected spans are rewritten, never the XML tree. */
function parsePart(name: string, xml: string): XmlPart {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`文档部件 ${name} 不允许 DTD 或实体声明`)
  const encoding = xml.match(/<\?xml[^?]*encoding\s*=\s*['"]([^'"]+)['"]/i)?.[1]
  if (encoding && !/^utf-?8$/i.test(encoding)) throw new Error(`文档部件 ${name} 不是支持的 UTF-8 XML`)
  if (XMLValidator.validate(xml) !== true) throw new Error(`文档部件 ${name} 的 XML 无效`)
  const elements: XmlElement[] = []
  const stack: XmlElement[] = []
  let cursor = 0
  while ((cursor = xml.indexOf('<', cursor)) !== -1) {
    if (xml.startsWith('<!--', cursor)) { cursor = xml.indexOf('-->', cursor) + 3; continue }
    if (xml.startsWith('<?', cursor)) { cursor = xml.indexOf('?>', cursor) + 2; continue }
    if (xml.startsWith('<![CDATA[', cursor)) { cursor = xml.indexOf(']]>', cursor) + 3; continue }
    let end = cursor + 1
    let quote = ''
    for (; end < xml.length; end++) {
      const char = xml[end]
      if (quote) { if (char === quote) quote = '' }
      else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    const tag = xml.slice(cursor, end + 1)
    if (tag.startsWith('</')) {
      const element = stack.pop()
      if (!element) throw new Error(`文档部件 ${name} 标签不匹配`)
      element.closeStart = cursor
      element.end = end + 1
    } else {
      const qualified = tag.match(/^<([^\s/>]+)/)?.[1]
      if (!qualified) throw new Error(`文档部件 ${name} 含有不支持的 XML 标记`)
      const parent = stack.at(-1)
      const attributes: Record<string, string> = {}
      for (const match of tag.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[match[1]] = xmlText(match[2] ?? match[3])
      const namespaces = { ...parent?.namespaces }
      for (const [key, value] of Object.entries(attributes)) {
        if (key === 'xmlns') namespaces[''] = value
        else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value
      }
      const [prefix, local] = qualified.includes(':') ? qualified.split(':', 2) : ['', qualified]
      const selfClosing = /\/\s*>$/.test(tag)
      const element: XmlElement = { name: qualified, local, namespace: namespaces[prefix] ?? '', namespaces, attributes,
        start: cursor, openEnd: end + 1, closeStart: selfClosing ? end + 1 : -1, end: selfClosing ? end + 1 : -1,
        selfClosing, parent, children: [] }
      parent?.children.push(element)
      elements.push(element)
      if (elements.length > MAX_ELEMENTS) throw new Error(`文档部件 ${name} 的节点数超过编辑上限`)
      if (!selfClosing) stack.push(element)
    }
    cursor = end + 1
  }
  return { name, xml, elements }
}

const belongs = (element: XmlElement | undefined, namespace: Set<string>, local: string): boolean => Boolean(element && namespace.has(element.namespace) && element.local === local)
const descendants = (element: XmlElement): XmlElement[] => element.children.flatMap((child) => [child, ...descendants(child)])
const inner = (part: XmlPart, element: XmlElement): string => element.selfClosing ? '' : part.xml.slice(element.openEnd, element.closeStart)
const content = (part: XmlPart, element: XmlElement): string => xmlText(inner(part, element))
const direct = (element: XmlElement, local: string): XmlElement | undefined => element.children.find((child) => child.local === local && child.namespace === element.namespace)
const stringTextNodes = (element: XmlElement): XmlElement[] => descendants(element).filter((child) => {
  if (!belongs(child, S, 't')) return false
  for (let parent = child.parent; parent && parent !== element; parent = parent.parent) if (belongs(parent, S, 'rPh')) return false
  return true
})

function collectParagraphs(part: XmlPart, namespaces: Set<string>, signed: boolean): Paragraph[] {
  return part.elements.filter((element) => belongs(element, namespaces, 'p')).map((element, paragraphIndex) => {
    const segments: TextSegment[] = []
    let text = ''
    let reason: string | undefined = signed ? '数字签名文档不允许编辑' : undefined
    for (const child of descendants(element)) {
      let nearest = child.parent
      while (nearest && !belongs(nearest, namespaces, 'p')) nearest = nearest.parent
      if (nearest !== element || !namespaces.has(child.namespace)) continue
      if (['fldSimple', 'fldChar', 'instrText', 'ins', 'del', 'moveFrom', 'moveTo', 'fld'].includes(child.local)) reason = '包含字段或修订记录，不能安全替换'
      if (['br', 'cr', 'tab'].includes(child.local)) text += child.local === 'tab' ? '\t' : '\n'
      if (child.local !== 't') continue
      if (child.children.length || /</.test(inner(part, child))) reason = '包含复杂文本节点，不能安全替换'
      const value = content(part, child)
      segments.push({ element: child, text: value, start: text.length, end: text.length + value.length })
      text += value
    }
    return { element, segments, location: { id: `${part.name}#p:${paragraphIndex}`, part: part.name, paragraphIndex, text,
      editable: !reason && segments.length > 0, ...(reason ? { reason } : {}) } }
  })
}

function normalizeCell(address: string): string {
  if (typeof address !== 'string' || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) throw new Error('单元格地址必须是明确的 A1 地址，如 B12')
  let column = 0
  for (const char of address.match(/^[A-Z]+/)![0]) column = column * 26 + char.charCodeAt(0) - 64
  if (column > 16_384 || Number(address.match(/\d+$/)![0]) > 1_048_576) throw new Error('单元格地址超出 XLSX 工作表范围')
  return address
}

function coordinates(address: string): [number, number] {
  let column = 0
  for (const char of address.match(/^[A-Z]+/)![0]) column = column * 26 + char.charCodeAt(0) - 64
  return [column, Number(address.match(/\d+$/)![0])]
}

function inRange(address: string, first: string, last: string): boolean {
  const [col, row] = coordinates(address), [left, top] = coordinates(first), [right, bottom] = coordinates(last)
  return col >= left && col <= right && row >= top && row <= bottom
}

function relationshipTarget(target: string): string {
  const decoded = decodeURIComponent(target)
  if (decoded.includes('\\') || /[?#\x00]/.test(decoded)) throw new Error('工作表关系路径无效')
  const result = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join('xl', decoded))
  if (result.startsWith('../') || result === '..') throw new Error('工作表关系路径越界')
  return result
}

function buildSheets(parts: Map<string, XmlPart>): Sheet[] {
  const workbook = parts.get('xl/workbook.xml')!
  const relationships = parts.get('xl/_rels/workbook.xml.rels')
  if (!relationships) throw new Error('XLSX 缺少工作表关系文件')
  const stringsPart = parts.get('xl/sharedStrings.xml')
  const strings = stringsPart ? stringsPart.elements.filter((element) => belongs(element, S, 'si')).map((element) => ({
    text: stringTextNodes(element).map((child) => content(stringsPart, child)).join(''), element, part: stringsPart,
  })) : []
  const names = new Set<string>()
  return workbook.elements.filter((element) => belongs(element, S, 'sheet')).map((sheet) => {
    const name = sheet.attributes.name
    const relationId = Object.entries(sheet.attributes).find(([key]) => key.endsWith(':id'))?.[1]
    if (!name || names.has(name.toLowerCase())) throw new Error('XLSX 工作表名称缺失或有歧义')
    names.add(name.toLowerCase())
    const matches = relationships.elements.filter((element) => element.local === 'Relationship' && element.attributes.Id === relationId)
    if (matches.length !== 1 || matches[0].attributes.TargetMode === 'External' || !matches[0].attributes.Target) {
      throw new Error(`工作表 ${name} 的关系不唯一或不是文档内部部件`)
    }
    const part = parts.get(relationshipTarget(matches[0].attributes.Target))
    if (!part) throw new Error(`工作表 ${name} 的 XML 部件不存在`)
    const worksheet = matches[0].attributes.Type?.endsWith('/worksheet')
    if (worksheet && !belongs(part.elements[0], S, 'worksheet')) throw new Error(`工作表 ${name} 的 XML 部件类型错误`)
    const cells = worksheet ? part.elements.filter((element) => belongs(element, S, 'c') && belongs(element.parent, S, 'row')) : []
    const addresses = new Set<string>()
    for (const cell of cells) {
      const address = normalizeCell(cell.attributes.r)
      if (addresses.has(address)) throw new Error(`工作表 ${name} 的 ${address} 重复，定位有歧义`)
      addresses.add(address)
      for (const tag of ['f', 'v', 'is']) {
        if (cell.children.filter((child) => child.local === tag && child.namespace === cell.namespace).length > 1) throw new Error(`单元格 ${name}!${address} 的内容有歧义`)
      }
    }
    const blocked: Sheet['blocked'] = []
    for (const element of part.elements) {
      let range: string | undefined, reason: string | undefined
      if (belongs(element, S, 'mergeCell')) { range = element.attributes.ref; reason = '合并单元格只能修改左上角锚点' }
      else if (belongs(element, S, 'f') && ['shared', 'array', 'dataTable'].includes(element.attributes.t)) {
        range = element.attributes.ref ?? element.parent?.attributes.r; reason = '共享、数组或数据表公式不能局部修改'
      }
      if (range && reason) {
        const [first, last = first] = range.split(':')
        blocked.push({ first: normalizeCell(first), last: normalizeCell(last), reason })
      }
    }
    return { name, part, cells, strings, blocked, ...(!worksheet ? { reason: '图表或对话工作表仅保留，不支持按单元格编辑' } : {}) }
  })
}

function cellProblem(sheet: Sheet, cell: XmlElement, signed: boolean): string | undefined {
  if (signed) return '数字签名文档不允许编辑'
  if (cell.attributes.cm || cell.attributes.vm) return '包含动态数组或值元数据，不能安全局部修改'
  const source = cell.attributes.t === 's' ? sharedStringForCell(sheet, cell) : undefined
  const text = source?.element ?? direct(cell, 'is')
  if (text && descendants(text).some((element) => belongs(element, S, 'rPh'))) return '包含拼音或注音排版，不能安全局部修改'
  const formula = direct(cell, 'f')
  if (formula && formula.attributes.t && formula.attributes.t !== 'normal') return '共享、数组或数据表公式不能局部修改'
  const address = cell.attributes.r
  return sheet.blocked.find((range) => inRange(address, range.first, range.last) &&
    !(range.reason.startsWith('合并') && address === range.first))?.reason
}

function sharedStringForCell(sheet: Sheet, cell: XmlElement): Sheet['strings'][number] {
  const v = direct(cell, 'v')
  const raw = v ? content(sheet.part, v) : ''
  const index = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(index) || !sheet.strings[index]) throw new Error(`单元格 ${sheet.name}!${cell.attributes.r} 的共享字符串索引不存在`)
  return sheet.strings[index]
}

function cellValue(sheet: Sheet, cell: XmlElement): OfficeCellLocation {
  const type = cell.attributes.t ?? 'n'
  const v = direct(cell, 'v')
  const raw = v ? content(sheet.part, v) : ''
  let value: OfficeCellLocation['value'] = null
  if (type === 's') value = sharedStringForCell(sheet, cell).text
  else if (type === 'inlineStr') {
    const node = direct(cell, 'is')
    value = node ? stringTextNodes(node).map((child) => content(sheet.part, child)).join('') : ''
  } else if (type === 'b' && raw) value = raw === '1'
  else if (raw) value = type === 'n' && Number.isFinite(Number(raw)) ? Number(raw) : raw
  const formula = direct(cell, 'f')
  return { address: cell.attributes.r, type, value, ...(formula ? { formula: content(sheet.part, formula) } : {}), editable: true }
}

async function loadPackage(buffer: Buffer, format: EditableOfficeFormat, signal?: AbortSignal): Promise<DocumentPackage> {
  signal?.throwIfAborted()
  if (!['docx', 'pptx', 'xlsx'].includes(format)) throw new Error('原版排版编辑仅支持 DOCX、PPTX 和 XLSX 模板')
  const zip = await JSZip.loadAsync(buffer)
  const entries = Object.values(zip.files)
  if (entries.length > 10_000) throw new Error('文档压缩包包含过多条目')
  let size = 0
  for (const entry of entries) {
    const original = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name
    if (original !== entry.name || original.includes('\\') || original.startsWith('/') || original.split('/').includes('..')) throw new Error('文档压缩包包含不安全路径')
    size += (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    if (size > MAX_UNPACKED_BYTES) throw new Error('文档解压后超过 100 MB 编辑上限')
  }
  const mainName = format === 'docx' ? 'word/document.xml' : format === 'pptx' ? 'ppt/presentation.xml' : 'xl/workbook.xml'
  if (!zip.file(mainName)) throw new Error(`不是有效的 ${format.toUpperCase()} 文档`)
  const parts = new Map<string, XmlPart>()
  let signed = entries.some((entry) => /^_xmlsignatures\//i.test(entry.name))
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (entry.dir || !/\.xml$|\.rels$/i.test(entry.name)) continue
    const isMetadata = entry.name === '[Content_Types].xml' || /\.rels$/i.test(entry.name)
    const selected = entry.name === mainName || (format === 'docx' ? /^word\/(?:header\d+|footer\d+|footnotes|endnotes|comments|glossary\/document)\.xml$/.test(entry.name)
      : format === 'pptx' ? /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(entry.name)
        : /^xl\/(?:worksheets|chartsheets|dialogsheets)\/[^/]+\.xml$/i.test(entry.name) || entry.name === 'xl/sharedStrings.xml' || entry.name === 'xl/_rels/workbook.xml.rels')
    if (!selected && !isMetadata) continue
    const bytes = await entry.async('nodebuffer')
    if (bytes.length > MAX_XML_PART_BYTES) throw new Error(`文档部件 ${entry.name} 超过 20 MB 编辑上限`)
    const xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (isMetadata && /digital-signature|xmlsignature/i.test(xml)) signed = true
    if (selected) parts.set(entry.name, parsePart(entry.name, xml))
  }
  const main = parts.get(mainName)!
  const expected = format === 'docx' ? W : format === 'pptx' ? P : S
  const rootName = format === 'docx' ? 'document' : format === 'pptx' ? 'presentation' : 'workbook'
  if (!main.elements[0] || !belongs(main.elements[0], expected, rootName)) throw new Error(`不是有效的 ${format.toUpperCase()} 主文档`)
  const paragraphs = new Map<string, Paragraph>()
  if (format !== 'xlsx') for (const part of parts.values()) {
    if (part.name === 'ppt/presentation.xml') continue
    for (const paragraph of collectParagraphs(part, format === 'docx' ? W : A, signed)) paragraphs.set(paragraph.location.id, paragraph)
  }
  const sheets = format === 'xlsx' ? buildSheets(parts) : []
  signal?.throwIfAborted()
  return { zip, signed, format, parts, paragraphs, sheets }
}

export async function inspectOfficeDocument(buffer: Buffer, format: EditableOfficeFormat, signal?: AbortSignal): Promise<OfficeInspection> {
  const document = await loadPackage(buffer, format, signal)
  return { format, signed: document.signed, textLocations: [...document.paragraphs.values()].map((paragraph) => paragraph.location),
    sheets: document.sheets.map((sheet) => ({ name: sheet.name, part: sheet.part.name, editable: !sheet.reason && !document.signed,
      ...(sheet.reason ? { reason: sheet.reason } : {}), cells: sheet.cells.map((cell) => {
      const reason = cellProblem(sheet, cell, document.signed)
      return { ...cellValue(sheet, cell), editable: !reason, ...(reason ? { reason } : {}) }
    }) })) }
}

function applyPatches(xml: string, patches: Patch[]): string {
  let previous = xml.length + 1
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    if (patch.end > previous) throw new Error('同一文本或单元格被重复编辑，修改范围重叠')
    xml = xml.slice(0, patch.start) + patch.text + xml.slice(patch.end)
    previous = patch.start
  }
  return xml
}

function attributeTag(tag: string, key: string, value?: string): string {
  const pattern = new RegExp(`\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'g')
  const cleaned = tag.replace(pattern, '')
  if (value === undefined) return cleaned
  return cleaned.replace(/\/?\s*>$/, (ending) => ` ${key}="${escapeXml(value)}"${ending}`)
}

function textNodePatch(part: XmlPart, element: XmlElement, value: string): Patch {
  const oldOpen = part.xml.slice(element.start, element.openEnd)
  let opening = /^\s|\s$/.test(value) ? attributeTag(oldOpen, 'xml:space', 'preserve') : oldOpen
  if (element.selfClosing) opening = opening.replace(/\/\s*>$/, '>')
  const closing = element.selfClosing ? `</${element.name}>` : part.xml.slice(element.closeStart, element.end)
  return { start: element.start, end: element.end, text: `${opening}${escapeXml(value)}${closing}` }
}

function replacementPatches(part: XmlPart, segments: TextSegment[], replacements: TextReplacement[]): Patch[] {
  const values = new Map<TextSegment, string>()
  for (const { start, length, replacement } of [...replacements].sort((a, b) => b.start - a.start)) {
    const affected = segments.filter((segment) => segment.start < start + length && segment.end > start)
    const chars = Array.from(replacement)
    for (const [index, segment] of affected.entries()) {
      const left = Math.max(0, start - segment.start)
      const right = Math.min(segment.text.length, start + length - segment.start)
      const count = index === affected.length - 1 ? chars.length : Array.from(segment.text.slice(left, right)).length
      const current = values.get(segment) ?? segment.text
      values.set(segment, current.slice(0, left) + chars.splice(0, count).join('') + current.slice(right))
    }
  }
  return [...values].map(([segment, value]) => textNodePatch(part, segment.element, value))
}

function cellPatch(sheet: Sheet, cell: XmlElement, edit: OfficeCellChange): Patch {
  let opening = sheet.part.xml.slice(cell.start, cell.openEnd)
  const prefix = cell.name.includes(':') ? cell.name.slice(0, cell.name.indexOf(':') + 1) : ''
  let replacement = ''
  let type: string | undefined
  if ('formula' in edit && edit.formula !== undefined) {
    if (typeof edit.formula !== 'string' || !edit.formula.trim()) throw new Error('公式内容不能为空')
    const formula = edit.formula.trim().replace(/^=/, '')
    if (!formula.trim()) throw new Error('公式内容不能为空')
    replacement = `<${prefix}f>${escapeXml(formula)}</${prefix}f>`
  } else if (edit.value !== null) {
    if (typeof edit.value === 'number') {
      if (!Number.isFinite(edit.value)) throw new Error('单元格数值必须是有限数字')
      replacement = `<${prefix}v>${edit.value}</${prefix}v>`
    } else if (typeof edit.value === 'boolean') {
      type = 'b'; replacement = `<${prefix}v>${edit.value ? 1 : 0}</${prefix}v>`
    } else if (typeof edit.value === 'string') {
      type = 'inlineStr'
      escapeXml(edit.value)
      const source = cell.attributes.t === 's' ? sharedStringForCell(sheet, cell) : undefined
      const inline = direct(cell, 'is')
      const textPart = source?.part ?? sheet.part
      const textElement = source?.element ?? inline
      let textXml: string | undefined
      let inlineOpening = `<${prefix}is>`
      if (textElement) {
        const nodes = stringTextNodes(textElement)
        let offset = 0
        const segments = nodes.map((element) => { const text = content(textPart, element); const segment = { element, text, start: offset, end: offset + text.length }; offset += text.length; return segment })
        const textPatches = offset > 0 ? replacementPatches(textPart, segments, [{ start: 0, length: offset, replacement: edit.value }])
          : nodes[0] ? [textNodePatch(textPart, nodes[0], edit.value)] : []
        if (textPatches.length) textXml = applyPatches(inner(textPart, textElement), textPatches.map((patch) => ({
          ...patch, start: patch.start - textElement.openEnd, end: patch.end - textElement.openEnd,
        })))
        for (const [name, namespace] of Object.entries(textElement.namespaces)) {
          if (cell.namespaces[name] !== namespace) inlineOpening = attributeTag(inlineOpening, name ? `xmlns:${name}` : 'xmlns', namespace)
        }
      }
      // A cloned shared string keeps rich-text run styles and does not affect cells sharing its index.
      replacement = `${inlineOpening}${textXml ?? `<${prefix}t xml:space="preserve">${escapeXml(edit.value)}</${prefix}t>`}</${prefix}is>`
    } else throw new Error('单元格内容必须是字符串、数值、布尔值或 null')
  }
  const preserved = cell.children.filter((child) => !['f', 'v', 'is'].includes(child.local)).map((child) => sheet.part.xml.slice(child.start, child.end)).join('')
  opening = attributeTag(opening, 't', type).replace(/\/\s*>$/, '>')
  return { start: cell.start, end: cell.end, text: `${opening}${replacement}${preserved}</${cell.name}>` }
}

/** Pure buffer-in/buffer-out editing. The caller must save this result to a new copy. */
export async function editOfficeDocument(buffer: Buffer, format: EditableOfficeFormat, edits: OfficeDocumentEdit[], signal?: AbortSignal): Promise<OfficeEditResult> {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 500) throw new Error('需要提供 1 到 500 个明确的文档修改')
  const document = await loadPackage(buffer, format, signal)
  if (document.signed) throw new Error('文档包含数字签名；修改会使签名失效，已拒绝编辑')
  const patches = new Map<string, Patch[]>()
  const changes: OfficeChangeReport[] = []
  const textReplacements = new Map<string, TextReplacement[]>()
  const used = new Set<string>()
  for (const edit of edits) {
    signal?.throwIfAborted()
    if (!edit || typeof edit !== 'object') throw new Error('文档修改格式无效')
    if (edit.kind === 'text') {
      if (format === 'xlsx') throw new Error('XLSX 请按工作表和单元格定位修改')
      const paragraph = document.paragraphs.get(edit.location)
      if (!paragraph) throw new Error(`文本位置 ${edit.location} 不存在，请先检查文档定位报告`)
      if (!paragraph.location.editable) throw new Error(paragraph.location.reason ?? '该位置没有可编辑文字')
      if (typeof edit.find !== 'string' || !edit.find || typeof edit.replacement !== 'string') throw new Error('文本修改必须提供非空 find 和 replacement 字符串')
      if (/[\r\n\t]/.test(edit.find + edit.replacement)) throw new Error('保留排版编辑不支持增加或跨越换行、制表符')
      escapeXml(edit.find); escapeXml(edit.replacement)
      const start = paragraph.location.text.indexOf(edit.find)
      if (start < 0) throw new Error(`位置 ${edit.location} 找不到要替换的文本`)
      if (paragraph.location.text.indexOf(edit.find, start + 1) !== -1) throw new Error(`位置 ${edit.location} 的匹配有歧义，请提供唯一完整文本`)
      const key = `${edit.location}:${start}:${start + edit.find.length}`
      if (used.has(key)) throw new Error('同一文本位置被重复修改')
      used.add(key)
      const replacements = textReplacements.get(edit.location) ?? []
      if (replacements.some((other) => start < other.start + other.length && start + edit.find.length > other.start)) throw new Error('文本修改范围重叠')
      replacements.push({ start, length: edit.find.length, replacement: edit.replacement })
      textReplacements.set(edit.location, replacements)
      changes.push({ kind: 'text', location: edit.location, before: edit.find, after: edit.replacement })
    } else if (edit.kind === 'cell') {
      if (format !== 'xlsx') throw new Error('单元格修改只支持 XLSX')
      const sheet = document.sheets.find((item) => item.name === edit.sheet)
      if (!sheet) throw new Error(`工作表 ${edit.sheet} 不存在，请使用定位报告中的确切名称`)
      if (sheet.reason) throw new Error(sheet.reason)
      const address = normalizeCell(edit.cell)
      const cell = sheet.cells.find((item) => item.attributes.r === address)
      if (!cell) throw new Error(`单元格 ${edit.sheet}!${address} 不存在，本次编辑不会自动扩展模板`)
      if (('formula' in edit) === ('value' in edit)) throw new Error('单元格修改必须且只能提供 value 或 formula')
      const reason = cellProblem(sheet, cell, false)
      if (reason) throw new Error(reason)
      const key = `${sheet.part.name}!${address}`
      if (used.has(key)) throw new Error('同一单元格被重复修改')
      used.add(key)
      const before = cellValue(sheet, cell)
      patches.set(sheet.part.name, [...(patches.get(sheet.part.name) ?? []), cellPatch(sheet, cell, edit)])
      changes.push({ kind: 'cell', location: `${edit.sheet}!${address}`, before: before.formula ? `=${before.formula}` : before.value,
        after: edit.formula !== undefined ? `=${edit.formula.trim().replace(/^=/, '')}` : edit.value ?? null })
    } else throw new Error('只支持 text 或 cell 修改')
  }
  for (const [id, replacements] of textReplacements) {
    const paragraph = document.paragraphs.get(id)!
    const part = document.parts.get(paragraph.location.part)!
    patches.set(part.name, [...(patches.get(part.name) ?? []), ...replacementPatches(part, paragraph.segments, replacements)])
  }
  for (const [name, edits] of patches) {
    signal?.throwIfAborted()
    const xml = applyPatches(document.parts.get(name)!.xml, edits)
    parsePart(name, xml)
    const old = document.zip.file(name)!
    document.zip.file(name, xml, { date: old.date, comment: old.comment, unixPermissions: old.unixPermissions, dosPermissions: old.dosPermissions })
  }
  const output = await document.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  signal?.throwIfAborted()
  await loadPackage(output, format, signal)
  return { buffer: output, changes }
}
