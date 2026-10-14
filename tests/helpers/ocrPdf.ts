/** Minimal self-contained fixture PDFs: text pages or JPEG-only scanned pages. */
export function ocrFixturePdf(pages: Array<{ text?: string; image?: Buffer; width?: number; height?: number }>): Buffer {
  const objects: Buffer[] = [Buffer.alloc(0), Buffer.alloc(0), Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')]
  const pageIds: number[] = []
  for (const page of pages) {
    const id = objects.length + 1
    pageIds.push(id)
    const imageId = id + 2
    const command = page.image ? 'q 500 0 0 160 0 70 cm /Scan Do Q' : `BT /F1 20 Tf 30 220 Td (${(page.text ?? '').replace(/[\\()]/g, '\\$&')}) Tj ET`
    const content = Buffer.from(command)
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 300] /Resources << /Font << /F1 3 0 R >> ${page.image ? `/XObject << /Scan ${imageId} 0 R >>` : ''} >> /Contents ${id + 1} 0 R >>`))
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]))
    if (page.image) objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${page.width ?? 1000} /Height ${page.height ?? 320} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.image.length} >>\nstream\n`), page.image, Buffer.from('\nendstream')]))
  }
  objects[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>')
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`)
  const chunks = [Buffer.from('%PDF-1.4\n%Fixture\n')]
  const offsets: number[] = [0]
  let offset = chunks[0].length
  objects.forEach((object, index) => {
    offsets.push(offset)
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    chunks.push(chunk); offset += chunk.length
  })
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`))
  return Buffer.concat(chunks)
}
