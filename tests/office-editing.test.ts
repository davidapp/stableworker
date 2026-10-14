import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import { editOfficeDocument, inspectOfficeDocument, type OfficeDocumentEdit } from '../src/main/officeEditing'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships'

async function archive(parts: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(parts)) zip.file(name, content, { date: new Date('2024-01-01T00:00:00Z'), comment: `part ${name}` })
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', comment: 'template archive comment' })
}

async function unchangedParts(before: Buffer, after: Buffer, changed: string[]): Promise<void> {
  const old = await JSZip.loadAsync(before), current = await JSZip.loadAsync(after)
  expect(Object.keys(current.files).sort()).toEqual(Object.keys(old.files).sort())
  // JSZip preserves the archive comment at runtime, but its public root type omits it.
  expect((current as JSZip & { comment: string | null }).comment).toBe((old as JSZip & { comment: string | null }).comment)
  for (const [name, entry] of Object.entries(old.files)) {
    if (entry.dir || changed.includes(name)) continue
    expect(await current.file(name)!.async('nodebuffer'), name).toEqual(await entry.async('nodebuffer'))
    expect(current.file(name)!.comment, name).toBe(entry.comment)
  }
}

const docxParts = (paragraphs = '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Hello </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>world</w:t></w:r></w:p>'): Record<string, string | Buffer> => ({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
  'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:styleId="Title"><w:rPr><w:sz w:val="40"/></w:rPr></w:style></w:styles>`,
  'word/header1.xml': `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>`,
  'word/footer1.xml': `<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>Footer</w:t></w:r></w:p></w:ftr>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="${PR}"><Relationship Id="rImage" Type="${R}/image" Target="media/pic.png"/></Relationships>`,
  'word/media/pic.png': Buffer.from([0, 1, 2, 3, 255]),
})

async function xlsx(): Promise<Buffer> {
  return archive({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Revenue &amp; Costs" sheetId="7" r:id="rid"/></sheets><calcPr calcId="191029"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PR}"><Relationship Id="rid" Type="${R}/worksheet" Target="worksheets/custom.xml"/></Relationships>`,
    'xl/worksheets/custom.xml': `<worksheet xmlns="${S}"><dimension ref="A1:D3"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData><row r="1" ht="32" customHeight="1"><c r="A1" s="5" t="s"><v>0</v></c><c r="B1" s="2"><v>10</v></c><c r="C1" s="2"><f>B1*2</f><v>20</v></c><c r="D1" s="2"/></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"/><c r="C2"/></row></sheetData><mergeCells count="1"><mergeCell ref="B2:C2"/></mergeCells><drawing xmlns:r="${R}" r:id="chart"/></worksheet>`,
    'xl/sharedStrings.xml': `<sst xmlns="${S}" count="2" uniqueCount="1"><si><r><rPr><b/></rPr><t>Old </t></r><r><rPr><i/></rPr><t>name</t></r></si></sst>`,
    'xl/styles.xml': `<styleSheet xmlns="${S}"><cellXfs count="6"><xf numFmtId="0"/></cellXfs></styleSheet>`,
    'xl/charts/chart1.xml': `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:title/></c:chart></c:chartSpace>`,
    'xl/drawings/drawing1.xml': '<drawing>original drawing</drawing>',
    'xl/worksheets/_rels/custom.xml.rels': `<Relationships xmlns="${PR}"><Relationship Id="chart" Type="${R}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
  })
}

describe('OOXML text editing while retaining original template parts', () => {
  it('inspects main document, header and footer with exact stable paragraph locations', async () => {
    const report = await inspectOfficeDocument(await archive(docxParts()), 'docx')
    expect(report.textLocations.map((location) => [location.id, location.text])).toEqual([
      ['word/document.xml#p:0', 'Hello world'], ['word/header1.xml#p:0', 'Header'], ['word/footer1.xml#p:0', 'Footer'],
    ])
  })

  it('replaces text across differently formatted runs without changing styles, media, relationships, headers or footer', async () => {
    const source = await archive(docxParts())
    const original = Buffer.from(source)
    const result = await editOfficeDocument(source, 'docx', [{ kind: 'text', location: 'word/document.xml#p:0', find: 'Hello world', replacement: 'Original template edited' }])
    expect(source).toEqual(original)
    expect(result.changes).toEqual([{ kind: 'text', location: 'word/document.xml#p:0', before: 'Hello world', after: 'Original template edited' }])
    await unchangedParts(source, result.buffer, ['word/document.xml'])
    const xml = await (await JSZip.loadAsync(result.buffer)).file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:pPr><w:pStyle w:val="Title"/></w:pPr>')
    expect(xml).toContain('<w:rPr><w:b/></w:rPr>')
    expect(xml).toContain('<w:rPr><w:i/></w:rPr>')
    expect(xml).toContain('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>')
    expect((await inspectOfficeDocument(result.buffer, 'docx')).textLocations[0].text).toBe('Original template edited')
  })

  it('escapes XML symbols, keeps space semantics, and does not split supplementary Unicode characters', async () => {
    const source = await archive(docxParts('<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t>B</w:t></w:r></w:p>'))
    const result = await editOfficeDocument(source, 'docx', [{ kind: 'text', location: 'word/document.xml#p:0', find: 'AB', replacement: '🙂 & <new> ' }])
    const xml = await (await JSZip.loadAsync(result.buffer)).file('word/document.xml')!.async('string')
    expect(XMLValidator.validate(xml)).toBe(true)
    expect(xml).toContain('xml:space="preserve"')
    expect(xml).toContain('&amp;')
    expect((await inspectOfficeDocument(result.buffer, 'docx')).textLocations[0].text).toBe('🙂 & <new> ')
  })

  it('applies nonoverlapping edits within one run and edits headers independently', async () => {
    const source = await archive(docxParts('<w:p><w:r><w:t>first middle last</w:t></w:r></w:p>'))
    const edits: OfficeDocumentEdit[] = [
      { kind: 'text', location: 'word/document.xml#p:0', find: 'first', replacement: 'beginning' },
      { kind: 'text', location: 'word/document.xml#p:0', find: 'last', replacement: 'end' },
      { kind: 'text', location: 'word/header1.xml#p:0', find: 'Header', replacement: 'Letterhead' },
    ]
    const result = await editOfficeDocument(source, 'docx', edits)
    const report = await inspectOfficeDocument(result.buffer, 'docx')
    expect(report.textLocations[0].text).toBe('beginning middle end')
    expect(report.textLocations.find((location) => location.part === 'word/header1.xml')?.text).toBe('Letterhead')
    await unchangedParts(source, result.buffer, ['word/document.xml', 'word/header1.xml'])
  })

  it('refuses absent, ambiguous, overlapping and unsafe text modifications before producing a copy', async () => {
    const source = await archive(docxParts('<w:p><w:r><w:t>same same abcdef</w:t></w:r></w:p>'))
    const location = 'word/document.xml#p:0'
    await expect(editOfficeDocument(source, 'docx', [{ kind: 'text', location, find: 'missing', replacement: 'x' }])).rejects.toThrow('找不到')
    await expect(editOfficeDocument(source, 'docx', [{ kind: 'text', location, find: 'same', replacement: 'x' }])).rejects.toThrow('歧义')
    await expect(editOfficeDocument(source, 'docx', [{ kind: 'text', location: 'word/document.xml#p:99', find: 'same', replacement: 'x' }])).rejects.toThrow('不存在')
    await expect(editOfficeDocument(source, 'docx', [
      { kind: 'text', location, find: 'abcd', replacement: 'x' }, { kind: 'text', location, find: 'cdef', replacement: 'y' },
    ])).rejects.toThrow('重叠')
    await expect(editOfficeDocument(source, 'docx', [{ kind: 'text', location, find: 'abcdef', replacement: 'new\nparagraph' }])).rejects.toThrow('换行')
    await expect(editOfficeDocument(source, 'docx', [{ kind: 'text', location, find: 'abcdef', replacement: '\u0000' }])).rejects.toThrow('XML')
  })

  it('marks fields and tracked revisions non-editable and separates nested text-box paragraphs', async () => {
    const source = await archive(docxParts('<w:p><w:r><w:t>Outer</w:t><w:drawing><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:drawing></w:r></w:p><w:p><w:ins><w:r><w:t>Tracked</w:t></w:r></w:ins></w:p><w:p><w:r><w:fldChar w:fldCharType="begin"/><w:t>Field</w:t></w:r></w:p>'))
    const report = await inspectOfficeDocument(source, 'docx')
    expect(report.textLocations.slice(0, 2).map((location) => location.text)).toEqual(['Outer', 'Box'])
    expect(report.textLocations[2].editable).toBe(false)
    expect(report.textLocations[3].editable).toBe(false)
    await expect(editOfficeDocument(source, 'docx', [{ kind: 'text', location: 'word/document.xml#p:2', find: 'Tracked', replacement: 'new' }])).rejects.toThrow('修订')
  })

  it('patches PPTX cross-run text while preserving slide layout, positions, images, notes and relationships', async () => {
    const source = await archive({
      'ppt/presentation.xml': `<p:presentation xmlns:p="${P}"/>`,
      'ppt/slides/slide1.xml': `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="500" cy="300"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"/><a:t>Quarter </a:t></a:r><a:r><a:rPr i="1"/><a:t>one</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      'ppt/slideLayouts/slideLayout1.xml': '<layout>original</layout>',
      'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${PR}"><Relationship Id="rLayout" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
      'ppt/notesSlides/notesSlide1.xml': `<p:notes xmlns:p="${P}" xmlns:a="${A}"><a:p><a:r><a:t>Speaker notes</a:t></a:r></a:p></p:notes>`,
      'ppt/media/image1.png': Buffer.from('original image'),
    })
    const result = await editOfficeDocument(source, 'pptx', [{ kind: 'text', location: 'ppt/slides/slide1.xml#p:0', find: 'Quarter one', replacement: 'Quarter two' }])
    await unchangedParts(source, result.buffer, ['ppt/slides/slide1.xml'])
    const slide = await (await JSZip.loadAsync(result.buffer)).file('ppt/slides/slide1.xml')!.async('string')
    expect(slide).toContain('<a:xfrm><a:off x="100" y="200"/><a:ext cx="500" cy="300"/></a:xfrm>')
    expect(slide).toContain('<a:rPr b="1"/>')
    expect((await inspectOfficeDocument(result.buffer, 'pptx')).textLocations[0].text).toBe('Quarter two')
  })
})

describe('targeted XLSX cell XML editing', () => {
  it('finds the sheet through workbook relationships and reads shared strings, blanks and formula caches', async () => {
    const report = await inspectOfficeDocument(await xlsx(), 'xlsx')
    expect(report.sheets[0].name).toBe('Revenue & Costs')
    expect(report.sheets[0].part).toBe('xl/worksheets/custom.xml')
    expect(report.sheets[0].cells[0]).toMatchObject({ address: 'A1', value: 'Old name', type: 's' })
    expect(report.sheets[0].cells[2]).toMatchObject({ address: 'C1', value: 20, formula: 'B1*2' })
    expect(report.sheets[0].cells.find((cell) => cell.address === 'C2')?.editable).toBe(false)
  })

  it('writes values and formulas without regenerating styles, charts, merged cells or relationships', async () => {
    const source = await xlsx()
    const result = await editOfficeDocument(source, 'xlsx', [
      { kind: 'cell', sheet: 'Revenue & Costs', cell: 'B1', value: 25 },
      { kind: 'cell', sheet: 'Revenue & Costs', cell: 'C1', formula: '=B1*3' },
      { kind: 'cell', sheet: 'Revenue & Costs', cell: 'D1', value: true },
    ])
    await unchangedParts(source, result.buffer, ['xl/worksheets/custom.xml'])
    const xml = await (await JSZip.loadAsync(result.buffer)).file('xl/worksheets/custom.xml')!.async('string')
    expect(xml).toContain('<c r="B1" s="2"><v>25</v></c>')
    expect(xml).toContain('<c r="C1" s="2"><f>B1*3</f></c>')
    expect(xml).toContain('<c r="D1" s="2" t="b"><v>1</v></c>')
    expect(xml).toContain('<mergeCells count="1"><mergeCell ref="B2:C2"/></mergeCells>')
    expect(result.changes[1]).toEqual({ kind: 'cell', location: 'Revenue & Costs!C1', before: '=B1*2', after: '=B1*3' })
  })

  it('clones a rich shared string into the edited cell while keeping other users of the shared string unchanged', async () => {
    const source = await xlsx()
    const result = await editOfficeDocument(source, 'xlsx', [{ kind: 'cell', sheet: 'Revenue & Costs', cell: 'A1', value: 'New & formatted title ' }])
    await unchangedParts(source, result.buffer, ['xl/worksheets/custom.xml'])
    const xml = await (await JSZip.loadAsync(result.buffer)).file('xl/worksheets/custom.xml')!.async('string')
    expect(XMLValidator.validate(xml)).toBe(true)
    expect(xml).toContain('<rPr><b/></rPr>')
    expect(xml).toContain('<rPr><i/></rPr>')
    expect(xml).toContain('<c r="A2" t="s"><v>0</v></c>')
    const cells = (await inspectOfficeDocument(result.buffer, 'xlsx')).sheets[0].cells
    expect(cells.find((cell) => cell.address === 'A1')?.value).toBe('New & formatted title ')
    expect(cells.find((cell) => cell.address === 'A2')?.value).toBe('Old name')
  })

  it('writes a new inline string into an existing blank cell, and null clears a value while preserving the style', async () => {
    const source = await xlsx()
    const result = await editOfficeDocument(source, 'xlsx', [
      { kind: 'cell', sheet: 'Revenue & Costs', cell: 'D1', value: 'blank & now filled' },
      { kind: 'cell', sheet: 'Revenue & Costs', cell: 'B1', value: null },
    ])
    const xml = await (await JSZip.loadAsync(result.buffer)).file('xl/worksheets/custom.xml')!.async('string')
    expect(xml).toContain('<c r="B1" s="2"></c>')
    expect((await inspectOfficeDocument(result.buffer, 'xlsx')).sheets[0].cells.find((cell) => cell.address === 'D1')?.value).toBe('blank & now filled')
  })

  it('refuses missing sheets/cells, duplicated edits, non-anchor merged cells and nonfinite numbers', async () => {
    const source = await xlsx()
    await expect(editOfficeDocument(source, 'xlsx', [{ kind: 'cell', sheet: 'missing', cell: 'B1', value: 1 }])).rejects.toThrow('工作表')
    await expect(editOfficeDocument(source, 'xlsx', [{ kind: 'cell', sheet: 'Revenue & Costs', cell: 'XFD9', value: 1 }])).rejects.toThrow('不存在')
    await expect(editOfficeDocument(source, 'xlsx', [{ kind: 'cell', sheet: 'Revenue & Costs', cell: 'C2', value: 1 }])).rejects.toThrow('锚点')
    await expect(editOfficeDocument(source, 'xlsx', [{ kind: 'cell', sheet: 'Revenue & Costs', cell: 'B1', value: Infinity }])).rejects.toThrow('有限')
    await expect(editOfficeDocument(source, 'xlsx', [{ kind: 'cell', sheet: 'Revenue & Costs', cell: 'B1', value: 1 }, { kind: 'cell', sheet: 'Revenue & Costs', cell: 'B1', value: 2 }])).rejects.toThrow('重复')
  })

  it('refuses shared or array formula groups, including cells covered by the master range', async () => {
    const source = await xlsx()
    const zip = await JSZip.loadAsync(source)
    const part = 'xl/worksheets/custom.xml'
    zip.file(part, (await zip.file(part)!.async('string')).replace('<f>B1*2</f>', '<f t="array" ref="B1:C1">B1*2</f>'))
    const array = await zip.generateAsync({ type: 'nodebuffer' })
    await expect(editOfficeDocument(array, 'xlsx', [{ kind: 'cell', sheet: 'Revenue & Costs', cell: 'B1', value: 1 }])).rejects.toThrow('数组')
    await expect(editOfficeDocument(array, 'xlsx', [{ kind: 'cell', sheet: 'Revenue & Costs', cell: 'C1', formula: '=B1' }])).rejects.toThrow('数组')
  })

  it('preserves namespace bindings when cloning rich text from a separately prefixed shared-string part', async () => {
    const zip = await JSZip.loadAsync(await xlsx())
    const sheet = await zip.file('xl/worksheets/custom.xml')!.async('string')
    zip.file('xl/worksheets/custom.xml', sheet.replace(/<\/?([a-zA-Z][\w]*)\b/g, (match) => match.startsWith('</') ? match.replace('</', '</x:') : match.replace('<', '<x:')).replace(`xmlns="${S}"`, `xmlns:x="${S}"`))
    zip.file('xl/sharedStrings.xml', `<ss:sst xmlns:ss="${S}"><ss:si><ss:r><ss:rPr><ss:b/></ss:rPr><ss:t>Old</ss:t></ss:r></ss:si></ss:sst>`)
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    const result = await editOfficeDocument(source, 'xlsx', [{ kind: 'cell', sheet: 'Revenue & Costs', cell: 'A1', value: 'new & title' }])
    const edited = await (await JSZip.loadAsync(result.buffer)).file('xl/worksheets/custom.xml')!.async('string')
    expect(edited).toContain(`xmlns:ss="${S}"`)
    expect(edited).toContain('<ss:rPr><ss:b/></ss:rPr>')
    expect((await inspectOfficeDocument(result.buffer, 'xlsx')).sheets[0].cells[0].value).toBe('new & title')
    await unchangedParts(source, result.buffer, ['xl/worksheets/custom.xml'])
  })

  it('retains chart sheets while allowing edits to the ordinary worksheets', async () => {
    const zip = await JSZip.loadAsync(await xlsx())
    zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml')!.async('string')).replace('</sheets>', '<sheet name="Chart" sheetId="8" r:id="chartSheet"/></sheets>'))
    zip.file('xl/_rels/workbook.xml.rels', (await zip.file('xl/_rels/workbook.xml.rels')!.async('string')).replace('</Relationships>', `<Relationship Id="chartSheet" Type="${R}/chartsheet" Target="chartsheets/sheet2.xml"/></Relationships>`))
    zip.file('xl/chartsheets/sheet2.xml', `<chartsheet xmlns="${S}" xmlns:r="${R}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><drawing r:id="chart"/></chartsheet>`)
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    expect((await inspectOfficeDocument(source, 'xlsx')).sheets[1]).toMatchObject({ name: 'Chart', editable: false, cells: [] })
    const result = await editOfficeDocument(source, 'xlsx', [{ kind: 'cell', sheet: 'Revenue & Costs', cell: 'B1', value: 30 }])
    await unchangedParts(source, result.buffer, ['xl/worksheets/custom.xml'])
  })

  it('excludes phonetic annotations from displayed text and refuses changing their attached rich string', async () => {
    const zip = await JSZip.loadAsync(await xlsx())
    zip.file('xl/sharedStrings.xml', `<sst xmlns="${S}"><si><t>中文</t><rPh sb="0" eb="2"><t>zhongwen</t></rPh></si></sst>`)
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    expect((await inspectOfficeDocument(source, 'xlsx')).sheets[0].cells[0]).toMatchObject({ value: '中文', editable: false })
    await expect(editOfficeDocument(source, 'xlsx', [{ kind: 'cell', sheet: 'Revenue & Costs', cell: 'A1', value: 'new' }])).rejects.toThrow('注音')
  })

  it('refuses duplicate cell addresses and broken shared-string indexes', async () => {
    const zip = await JSZip.loadAsync(await xlsx())
    const xml = await zip.file('xl/worksheets/custom.xml')!.async('string')
    zip.file('xl/worksheets/custom.xml', xml.replace('<c r="D1" s="2"/>', '<c r="B1"/>'))
    await expect(inspectOfficeDocument(await zip.generateAsync({ type: 'nodebuffer' }), 'xlsx')).rejects.toThrow('歧义')
    zip.file('xl/worksheets/custom.xml', xml.replace('<v>0</v>', '<v>999</v>'))
    await expect(inspectOfficeDocument(await zip.generateAsync({ type: 'nodebuffer' }), 'xlsx')).rejects.toThrow('索引不存在')
  })
})

describe('editing validation and cancellation', () => {
  it('allows inspecting a signed file but refuses all editing', async () => {
    const source = await archive({ ...docxParts(), '_xmlsignatures/sig1.xml': '<Signature>signed</Signature>' })
    expect((await inspectOfficeDocument(source, 'docx')).signed).toBe(true)
    await expect(editOfficeDocument(source, 'docx', [{ kind: 'text', location: 'word/document.xml#p:0', find: 'Hello world', replacement: 'new' }])).rejects.toThrow('数字签名')
  })

  it('refuses DTD, malformed XML and unsupported source formats', async () => {
    const source = docxParts()
    source['word/document.xml'] = '<!DOCTYPE test [<!ENTITY external SYSTEM "file:///secret">]><w:document/>'
    await expect(inspectOfficeDocument(await archive(source), 'docx')).rejects.toThrow('DTD')
    source['word/document.xml'] = `<w:document xmlns:w="${W}"><w:body></w:document>`
    await expect(inspectOfficeDocument(await archive(source), 'docx')).rejects.toThrow('XML')
    await expect(editOfficeDocument(Buffer.from('pdf'), 'pdf' as 'docx', [{ kind: 'text', location: 'x', find: 'a', replacement: 'b' }])).rejects.toThrow('仅支持')
  })

  it('honors cancellation and never mutates the source buffer on rejected batches', async () => {
    const source = await archive(docxParts())
    const copy = Buffer.from(source)
    const controller = new AbortController()
    controller.abort()
    await expect(editOfficeDocument(source, 'docx', [{ kind: 'text', location: 'word/document.xml#p:0', find: 'Hello world', replacement: 'new' }], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(editOfficeDocument(source, 'docx', [
      { kind: 'text', location: 'word/document.xml#p:0', find: 'Hello world', replacement: 'valid first edit' },
      { kind: 'text', location: 'missing', find: 'a', replacement: 'b' },
    ])).rejects.toThrow('不存在')
    expect(source).toEqual(copy)
  })
})

describe('round trips through real Office document libraries', () => {
  it('edits a generated DOCX and reopens its text, preserving the actual header/footer/styles relationships', async () => {
    const { Document, Header, Footer, Paragraph, TextRun, Packer } = await import('docx')
    const mammoth = (await import('mammoth')).default
    const document = new Document({ sections: [{
      headers: { default: new Header({ children: [new Paragraph('Company header')] }) },
      footers: { default: new Footer({ children: [new Paragraph('Company footer')] }) },
      children: [new Paragraph({ children: [new TextRun({ text: 'Customer ', bold: true }), new TextRun({ text: 'Alpha', italics: true })] })],
    }] })
    const source = await Packer.toBuffer(document)
    const inspection = await inspectOfficeDocument(source, 'docx')
    const location = inspection.textLocations.find((item) => item.text === 'Customer Alpha')!
    expect(inspection.textLocations.some((item) => item.text === 'Company header')).toBe(true)
    const result = await editOfficeDocument(source, 'docx', [{ kind: 'text', location: location.id, find: location.text, replacement: 'Customer Beta' }])
    expect((await mammoth.extractRawText({ buffer: result.buffer })).value).toContain('Customer Beta')
    await unchangedParts(source, result.buffer, [location.part])
  })

  it('edits an ExcelJS workbook without losing rich-text formatting, cell styles or merged ranges', async () => {
    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sales')
    sheet.getCell('A1').value = { richText: [{ text: 'Old', font: { bold: true } }, { text: ' label', font: { italic: true } }] }
    sheet.getCell('B1').value = 10
    sheet.getCell('B1').numFmt = '$#,##0.00'
    sheet.getCell('C1').value = { formula: 'B1*2', result: 20 }
    sheet.mergeCells('B2:C2')
    const source = Buffer.from(await workbook.xlsx.writeBuffer())
    const result = await editOfficeDocument(source, 'xlsx', [
      { kind: 'cell', sheet: 'Sales', cell: 'A1', value: 'New & label' },
      { kind: 'cell', sheet: 'Sales', cell: 'B1', value: 22 },
      { kind: 'cell', sheet: 'Sales', cell: 'C1', formula: '=B1*3' },
    ])
    const reopened = new ExcelJS.Workbook()
    await reopened.xlsx.load(result.buffer as unknown as Parameters<typeof reopened.xlsx.load>[0])
    const edited = reopened.getWorksheet('Sales')!
    expect(edited.getCell('A1').text).toBe('New & label')
    expect(edited.getCell('A1').value).toMatchObject({ richText: [{ text: 'New', font: { bold: true } }, { text: ' & label', font: { italic: true } }] })
    expect(edited.getCell('B1').value).toBe(22)
    expect(edited.getCell('B1').numFmt).toBe('$#,##0.00')
    expect(edited.getCell('C1').formula).toBe('B1*3')
    expect(edited.getCell('C1').result).toBeUndefined()
    expect(edited.getCell('C2').isMerged).toBe(true)
    await unchangedParts(source, result.buffer, ['xl/worksheets/sheet1.xml'])
  })

  it('edits PptxGenJS slide text while retaining all its actual layout/theme and notes parts', async () => {
    const PptxGenJS = (await import('pptxgenjs')).default
    const deck = new PptxGenJS()
    deck.layout = 'LAYOUT_WIDE'
    const slide = deck.addSlide()
    slide.addText([{ text: 'Quarter ', options: { bold: true } }, { text: 'one', options: { italic: true } }], { x: 1, y: 1, w: 8, h: 1, fontSize: 24 })
    slide.addNotes('Original speaker notes')
    const source = await deck.write({ outputType: 'nodebuffer' }) as Buffer
    const report = await inspectOfficeDocument(source, 'pptx')
    const location = report.textLocations.find((item) => item.text === 'Quarter one')!
    const result = await editOfficeDocument(source, 'pptx', [{ kind: 'text', location: location.id, find: location.text, replacement: 'Quarter two' }])
    expect((await inspectOfficeDocument(result.buffer, 'pptx')).textLocations.find((item) => item.id === location.id)?.text).toBe('Quarter two')
    await unchangedParts(source, result.buffer, [location.part])
  })
})
