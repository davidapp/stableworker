import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { calculateWorkbookCore } from '../src/main/officeFormulaCore'
import { calculateWorkbook } from '../src/main/officeFormulas'

async function workbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('数据 表')
  sheet.addRows([[1, '甲'], [2, '乙'], [3, '甲']])
  sheet.getCell('A1').numFmt = '0.00'
  sheet.getCell('A1').font = { bold: true, color: { argb: 'FF123456' } }
  sheet.mergeCells('E1:F1')
  const results = book.addWorksheet('结果')
  const formulas = [
    "SUM('数据 表'!A1:A3)", "AVERAGE('数据 表'!A1:A3)", 'IF(A1=6,"通过","失败")',
    'COUNTIF(\'数据 表\'!B1:B3,"甲")', 'SUMIF(\'数据 表\'!B1:B3,"甲",\'数据 表\'!A1:A3)',
    'A1+$A$2', 'A6*2', '1/0', 'NOT_SUPPORTED(A1)', 'IF(FALSE,A8,100)',
  ]
  formulas.forEach((formula, i) => { results.getCell(`A${i + 1}`).value = { formula, result: 999 } })
  const zip = await JSZip.loadAsync(Buffer.from(await book.xlsx.writeBuffer()))
  zip.file('custom/original-part.xml', '<original keep="yes">untouched binary template part</original>')
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function read(buffer: Buffer): Promise<ExcelJS.Workbook> { const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0]); return book }

describe('本地 Excel 公式计算', () => {
  it('SUM/AVERAGE/IF/COUNTIF/SUMIF、跨表、绝对引用与依赖顺序实际写入新缓存', async () => {
    const result = await calculateWorkbookCore(await workbook())
    const sheet = (await read(result.buffer)).getWorksheet('结果')!
    expect(Array.from({ length: 7 }, (_, i) => sheet.getCell(`A${i + 1}`).result)).toEqual([6, 2, '通过', 2, 4, 8, 16])
    expect(sheet.getCell('A10').result).toBe(100)
    expect(result.report.calculated).toBe(8)
    expect(result.report.unsupported).toEqual([expect.stringContaining('结果!A9')])
  })

  it('数学错误/不支持公式明确错误缓存且保留原formula，不读取旧999缓存', async () => {
    const result = await calculateWorkbookCore(await workbook())
    const sheet = (await read(result.buffer)).getWorksheet('结果')!
    expect(sheet.getCell('A8').value).toMatchObject({ formula: '1/0', result: { error: '#DIV/0!' } })
    expect(sheet.getCell('A9').value).toMatchObject({ formula: 'NOT_SUPPORTED(A1)', result: { error: '#NAME?' } })
    expect(result.report.warnings).toContain('结果!A8: #DIV/0!')
    expect(result.report.unsupported[0]).toContain('NOT_SUPPORTED')
  })

  it('除了公式cell缓存与类型，ZIP所有parts和模板排版保持原字节', async () => {
    const input = await workbook(), output = await calculateWorkbookCore(input)
    const before = await JSZip.loadAsync(input), after = await JSZip.loadAsync(output.buffer)
    expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort())
    for (const name of Object.keys(before.files).filter((name) => name !== 'xl/worksheets/sheet2.xml' && !before.files[name].dir)) {
      expect(await after.file(name)!.async('nodebuffer'), name).toEqual(await before.file(name)!.async('nodebuffer'))
    }
    const sheet = (await read(output.buffer)).getWorksheet('数据 表')!
    expect(sheet.getCell('A1').numFmt).toBe('0.00')
    expect(sheet.getCell('A1').font?.color?.argb).toBe('FF123456')
    expect(sheet.getCell('F1').isMerged).toBe(true)
  })

  it('跨sheet循环不挂起，所有循环参与者及依赖者写#REF而非旧cache', async () => {
    const book = new ExcelJS.Workbook(), first = book.addWorksheet('第一'), second = book.addWorksheet('第二')
    first.getCell('A1').value = { formula: '第二!A1+1', result: 999 }
    second.getCell('A1').value = { formula: '第一!A1+1', result: 999 }
    second.getCell('B1').value = { formula: 'A1*2', result: 999 }
    const result = await calculateWorkbookCore(Buffer.from(await book.xlsx.writeBuffer()))
    const output = await read(result.buffer)
    for (const [sheet, cell] of [['第一', 'A1'], ['第二', 'A1'], ['第二', 'B1']]) expect(output.getWorksheet(sheet)!.getCell(cell).result).toEqual({ error: '#REF!' })
    expect(result.report.warnings.some((warning) => warning.includes('循环依赖'))).toBe(true)
    expect(result.report.calculated).toBe(0)
  })

  it('共享公式按相对/绝对引用展开计算，但原共享formula XML不改', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Shared')
    sheet.addRows([[2, 10], [3, 20]])
    sheet.getCell('C1').value = { formula: 'A1+$B$1', result: 999 }
    sheet.getCell('C2').value = { formula: 'A2+$B$1', result: 999 }
    const zip = await JSZip.loadAsync(Buffer.from(await book.xlsx.writeBuffer()))
    const original = (await zip.file('xl/worksheets/sheet1.xml')!.async('string')).replace('<f>A1+$B$1</f>', '<f t="shared" si="0" ref="C1:C2">A1+$B$1</f>').replace('<f>A2+$B$1</f>', '<f t="shared" si="0"/>')
    zip.file('xl/worksheets/sheet1.xml', original)
    const result = await calculateWorkbookCore(await zip.generateAsync({ type: 'nodebuffer' }))
    const output = await read(result.buffer)
    expect(output.getWorksheet('Shared')!.getCell('C1').result).toBe(12)
    expect(output.getWorksheet('Shared')!.getCell('C2').result).toBe(13)
    const xml = await (await JSZip.loadAsync(result.buffer)).file('xl/worksheets/sheet1.xml')!.async('string')
    expect(xml).toContain('<f t="shared" si="0" ref="C1:C2">A1+$B$1</f>')
    expect(xml).toContain('<f t="shared" si="0"/>')
  })

  it('超大range及外部引用明确拒绝，不保留已有的旧cache', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Bounds')
    sheet.getCell('A1').value = { formula: 'SUM(B1:B100001)', result: 999 }
    sheet.getCell('A2').value = { formula: "'[outside.xlsx]Sheet1'!A1", result: 999 }
    const result = await calculateWorkbookCore(Buffer.from(await book.xlsx.writeBuffer()))
    const output = (await read(result.buffer)).getWorksheet('Bounds')!
    expect(output.getCell('A1').result).toEqual({ error: '#NAME?' })
    expect(output.getCell('A2').result).toEqual({ error: '#NAME?' })
    expect(result.report.unsupported).toHaveLength(2)
  })

  it('已取消计算直接拒绝，不启动worker也不生成任何新buffer', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(calculateWorkbook(Buffer.alloc(0), controller.signal)).rejects.toThrow()
    await expect(calculateWorkbookCore(Buffer.alloc(0), controller.signal)).rejects.toThrow()
  })

  it('IF/IFERROR未选分支的除零或不支持错误不会污染已选分支', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Conditional')
    const formulas = ['1/0', 'IF(TRUE,42,A1)', 'IF(FALSE,A1,43)', 'IFERROR(A1,44)', 'IF(TRUE,45,1/0)', 'IFERROR(1/0,46)']
    formulas.forEach((formula, i) => { sheet.getCell(`A${i + 1}`).value = { formula, result: 999 } })
    const result = await calculateWorkbookCore(Buffer.from(await book.xlsx.writeBuffer()))
    const output = (await read(result.buffer)).getWorksheet('Conditional')!
    expect(Array.from({ length: 5 }, (_, i) => output.getCell(`A${i + 2}`).result)).toEqual([42, 43, 44, 45, 46])
    expect(result.report.calculated).toBe(5)
  })

  it('签名工作簿拒绝修改，不让签名失效却仍标为有效', async () => {
    const zip = await JSZip.loadAsync(await workbook())
    zip.file('_xmlsignatures/sig1.xml', '<Signature>original</Signature>')
    await expect(calculateWorkbookCore(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('数字签名')
  })

  it('不支持的array公式连同无f标签的spill旧缓存一起清除', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Array')
    sheet.getCell('A1').value = { formula: 'SUM(B1:B2)', result: 999 }
    sheet.getCell('A2').value = 999
    sheet.getCell('B1').value = 1; sheet.getCell('B2').value = 2
    sheet.getCell('C1').value = { formula: 'A2+1', result: 999 }
    const zip = await JSZip.loadAsync(Buffer.from(await book.xlsx.writeBuffer()))
    zip.file('xl/worksheets/sheet1.xml', (await zip.file('xl/worksheets/sheet1.xml')!.async('string')).replace('<f>SUM(B1:B2)</f>', '<f t="array" ref="A1:A2">SUM(B1:B2)</f>'))
    const result = await calculateWorkbookCore(await zip.generateAsync({ type: 'nodebuffer' }))
    const output = (await read(result.buffer)).getWorksheet('Array')!
    expect(output.getCell('A1').result).toEqual({ error: '#NAME?' })
    expect(output.getCell('A2').value).toEqual({ error: '#NAME?' })
    expect(output.getCell('C1').result).toEqual({ error: '#NAME?' })
    expect(result.report.unsupported[0]).toContain('array')
  })

  it('SUMIF的单cell sum_range扩展到后续formula时不复用旧cache或破坏parser状态', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('SumRange')
    sheet.addRows([['甲', 10], ['乙', 20], ['甲', 30]])
    sheet.getCell('D1').value = { formula: 'SUMIF(A1:A3,"甲",B1)', result: 999 }
    sheet.getCell('B3').value = { formula: 'B1*3', result: 999 }
    const result = await calculateWorkbookCore(Buffer.from(await book.xlsx.writeBuffer()))
    const output = (await read(result.buffer)).getWorksheet('SumRange')!
    expect(output.getCell('D1').result).toBe(40)
    expect(output.getCell('B3').result).toBe(30)
    expect(result.report.unsupported).toEqual([])
    expect(result.report.warnings).toEqual([])
  })

  it.each(['ss', '表格'])('有效 namespace %s:c / f / v 正常计算并清除所有旧缓存', async (prefix) => {
    const zip = await JSZip.loadAsync(await workbook())
    const original = await zip.file('xl/worksheets/sheet2.xml')!.async('string')
    const prefixed = original.replace(/(<\/?)([A-Za-z][\w.-]*)(?=[\s/>])/g, `$1${prefix}:$2`).replace(`<${prefix}:worksheet `, `<${prefix}:worksheet xmlns:${prefix}="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `)
    zip.file('xl/worksheets/sheet2.xml', prefixed)
    const result = await calculateWorkbookCore(await zip.generateAsync({ type: 'nodebuffer' }))
    expect(result.report.calculated).toBe(8)
    expect(result.report.unsupported).toHaveLength(1)
    const output = await (await JSZip.loadAsync(result.buffer)).file('xl/worksheets/sheet2.xml')!.async('string')
    expect(output).toContain(`<${prefix}:f>SUM(&apos;数据 表&apos;!A1:A3)</${prefix}:f><${prefix}:v>6</${prefix}:v>`)
    expect(output).toContain(`<${prefix}:v>#DIV/0!</${prefix}:v>`)
    expect(output).toContain(`<${prefix}:v>#NAME?</${prefix}:v>`)
    expect(output).not.toContain(`<${prefix}:v>999</${prefix}:v>`)
  })

  it('SUMIF动态扩展发现cycle后，不用未选criteria分支的0覆盖已诊断的#REF', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('DynamicCycle')
    sheet.addRows([['甲', 1], ['甲', 2], ['甲', 3]])
    sheet.getCell('D1').value = { formula: 'SUMIF(A1:A3,"不存在",B1)', result: 999 }
    sheet.getCell('B3').value = { formula: 'D1+1', result: 999 }
    const result = await calculateWorkbookCore(Buffer.from(await book.xlsx.writeBuffer()))
    const output = (await read(result.buffer)).getWorksheet('DynamicCycle')!
    expect(output.getCell('D1').result).toEqual({ error: '#REF!' })
    expect(output.getCell('B3').result).toEqual({ error: '#REF!' })
    expect(result.report.calculated).toBe(0)
    expect(result.report.warnings.some((warning) => warning.includes('循环依赖'))).toBe(true)
  })

  it('ROUND采用十进制half-away规则，覆盖正负数、指数、负digits与引用参数', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Round')
    sheet.getCell('B1').value = 1.005; sheet.getCell('B2').value = 2
    const cases: [string, number][] = [
      ['ROUND(1.005,2)', 1.01], ['ROUND(1.275,2)', 1.28], ['ROUND(-1.005,2)', -1.01], ['ROUND(-1.275,2)', -1.28],
      ['ROUND(2.5,0)', 3], ['ROUND(-2.5,0)', -3], ['ROUND(150,-2)', 200], ['ROUND(-150,-2)', -200],
      ['ROUND(149,-2)', 100], ['ROUND(-149,-2)', -100], ['ROUND(1.005e-5,7)', 0.0000101], ['ROUND(1.005e+21,-19)', 1.01e21],
      ['ROUND(B1,B2)', 1.01], ['ROUND(1.249,1.9)', 1.2], ['ROUND(125,-1.9)', 130], ['ROUND(0,2)', 0],
    ]
    cases.forEach(([formula], i) => { sheet.getCell(`A${i + 1}`).value = { formula, result: 999 } })
    const result = await calculateWorkbookCore(Buffer.from(await book.xlsx.writeBuffer()))
    const output = (await read(result.buffer)).getWorksheet('Round')!
    expect(cases.map((_, i) => output.getCell(`A${i + 1}`).result)).toEqual(cases.map(([, expected]) => expected))
    expect(result.report).toEqual({ calculated: cases.length, unsupported: [], warnings: [] })
  })

  it('ROUNDUP远离零、ROUNDDOWN朝零，整数及恰好边界不多进一位', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Directions')
    sheet.getCell('B1').value = -1.275; sheet.getCell('B2').value = 2
    const cases: [string, number][] = [
      ['ROUNDUP(1.001,2)', 1.01], ['ROUNDUP(-1.001,2)', -1.01], ['ROUNDDOWN(1.009,2)', 1], ['ROUNDDOWN(-1.009,2)', -1],
      ['ROUNDUP(1,0)', 1], ['ROUNDUP(-1,0)', -1], ['ROUNDUP(1.01,2)', 1.01], ['ROUNDDOWN(1.01,2)', 1.01],
      ['ROUNDUP(149,-2)', 200], ['ROUNDUP(-149,-2)', -200], ['ROUNDDOWN(149,-2)', 100], ['ROUNDDOWN(-149,-2)', -100],
      ['ROUNDUP(B1,B2)', -1.28], ['ROUNDDOWN(B1,B2)', -1.27], ['ROUNDUP(5e-324,308)', 1e-308], ['ROUNDDOWN(5e-324,308)', 0],
    ]
    cases.forEach(([formula], i) => { sheet.getCell(`A${i + 1}`).value = { formula, result: 999 } })
    const result = await calculateWorkbookCore(Buffer.from(await book.xlsx.writeBuffer()))
    const output = (await read(result.buffer)).getWorksheet('Directions')!
    expect(cases.map((_, i) => output.getCell(`A${i + 1}`).result)).toEqual(cases.map(([, expected]) => expected))
    expect(result.report).toEqual({ calculated: cases.length, unsupported: [], warnings: [] })
  })

  it('ROUND参数越界/非finite/结果溢出明确缓存Excel错误并报告，不留旧cache', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('RoundErrors')
    const cases: [string, string][] = [
      ['ROUND(1,309)', '#NUM!'], ['ROUND(1,-309)', '#NUM!'], ['ROUND(1e+309,2)', '#NUM!'],
      ['ROUNDUP(1.7976931348623157e+308,-308)', '#NUM!'], ['ROUND(1,1e+309)', '#NUM!'],
      ['ROUND("wrong",2)', '#VALUE!'], ['ROUND(1)', '#VALUE!'], ['ROUND(1,2,3)', '#VALUE!'],
    ]
    cases.forEach(([formula], i) => { sheet.getCell(`A${i + 1}`).value = { formula, result: 999 } })
    const result = await calculateWorkbookCore(Buffer.from(await book.xlsx.writeBuffer()))
    const output = (await read(result.buffer)).getWorksheet('RoundErrors')!
    expect(cases.map((_, i) => output.getCell(`A${i + 1}`).result)).toEqual(cases.map(([, error]) => ({ error })))
    expect(result.report.calculated).toBe(0)
    expect(result.report.warnings).toHaveLength(cases.length)
  })

  it('COUNTBLANK统计真正空格与formula空文本，忽略0/false/空格文字/错误', async () => {
    const book = new ExcelJS.Workbook(), data = book.addWorksheet('BlankData'), summary = book.addWorksheet('BlankSummary')
    data.getCell('A1').value = 0; data.getCell('A2').value = false; data.getCell('A3').value = ' '
    data.getCell('A4').value = { formula: '""', result: 'old' }; data.getCell('A5').value = { error: '#DIV/0!' }
    summary.getCell('A1').value = { formula: 'COUNTBLANK(BlankData!A1:A7)', result: 999 }
    summary.getCell('A2').value = { formula: 'COUNTBLANK(BlankData!A6)', result: 999 }
    summary.getCell('A3').value = { formula: 'COUNTBLANK(BlankData!A1)', result: 999 }
    summary.getCell('A4').value = { formula: 'COUNTBLANK(BlankData!A4)', result: 999 }
    summary.getCell('A5').value = { formula: 'COUNTBLANK(BlankData!A5)', result: 999 }
    summary.getCell('A6').value = { formula: 'COUNTBLANK(1)', result: 999 }
    const result = await calculateWorkbookCore(Buffer.from(await book.xlsx.writeBuffer()))
    const output = (await read(result.buffer)).getWorksheet('BlankSummary')!
    expect(Array.from({ length: 5 }, (_, i) => output.getCell(`A${i + 1}`).result)).toEqual([3, 1, 0, 1, 0])
    expect(output.getCell('A6').result).toEqual({ error: '#VALUE!' })
    expect(result.report.calculated).toBe(6)
    expect(result.report.warnings).toEqual(['BlankSummary!A6: #VALUE!'])
  })
})
