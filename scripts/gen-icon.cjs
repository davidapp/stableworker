// 一次性脚本：程序化生成应用图标 build/icon.png（1024x1024 RGBA）
// 设计：圆角方 + 紫蓝对角渐变 + 白色对话气泡（圆角矩形 + 尾巴）
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const S = 1024

// ---- PNG 编码（RGBA，无滤波） ----
const crcTable = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

// ---- 绘制 ----
const px = Buffer.alloc(S * S * 4)

function insideRounded(px0, py0, x, y, w, h, r) {
  if (px0 < x || px0 > x + w || py0 < y || py0 > y + h) return false
  const cx = Math.max(x + r, Math.min(px0, x + w - r))
  const cy = Math.max(y + r, Math.min(py0, y + h - r))
  const dx = px0 - cx
  const dy = py0 - cy
  return dx * dx + dy * dy <= r * r
}

function pointInTriangle(p, a, b, c) {
  const s1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
  const s2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0])
  const s3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0])
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0
  return !(hasNeg && hasPos)
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4

    // 底：圆角方 + 对角渐变（紫 #8b7cff → 蓝 #61a5ff）
    let r = 0
    let g = 0
    let b = 0
    if (insideRounded(x, y, 0, 0, S, S, 190)) {
      const t = Math.min(1, (x + y) / (2 * S))
      r = Math.round(139 + (97 - 139) * t)
      g = Math.round(124 + (165 - 124) * t)
      b = Math.round(255)
    }

    // 白色对话气泡：圆角矩形 + 左下尾巴
    let white = insideRounded(x, y, 192, 236, 640, 400, 92)
    if (!white && pointInTriangle([x, y], [300, 636], [300, 790], [520, 636])) white = true

    if (white) {
      px[i] = 255
      px[i + 1] = 255
      px[i + 2] = 255
      px[i + 3] = 255
    } else {
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = 255
    }
  }
}

// ---- 写 PNG ----
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0 // filter: none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = path.join(__dirname, '..', 'build', 'icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log('icon written:', out, png.length, 'bytes')
