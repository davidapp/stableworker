/**
 * 金额的精确十进制运算工具。
 * JavaScript 的 number 是二进制浮点，无法精确表示 0.1 这类十进制小数；
 * 这里把金额放大成 1e-12（pico）单位的 BigInt 整数做加减，再转回十进制字符串，
 * 只要原始小数不超过 12 位，运算全程精确、不发生舍入。
 */

/** 十进制字符串 → pico 整数（值 × 1e12）。超过 12 位小数会被截断 */
export function decimalToPico(s: string): bigint {
  const [int = '0', frac = ''] = s.split('.')
  const f = (frac + '000000000000').slice(0, 12)
  return BigInt((int || '0') + f)
}

/** pico 整数 → 十进制字符串（去掉多余的末尾零，不引入任何舍入） */
export function picoToDecimalString(v: bigint): string {
  const s = v.toString().padStart(13, '0')
  const intPart = s.slice(0, -12)
  const frac = s.slice(-12).replace(/0+$/, '')
  return frac ? `${intPart}.${frac}` : intPart
}
