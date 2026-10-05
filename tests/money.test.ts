import { describe, expect, it } from 'vitest'
import { decimalToPico, picoToDecimalString } from '../src/shared/money'

describe('money 精确十进制运算', () => {
  it('十进制字符串与 pico 整数互转', () => {
    expect(decimalToPico('0.000874')).toBe(874000000n)
    expect(picoToDecimalString(874000000n)).toBe('0.000874')
    expect(picoToDecimalString(0n)).toBe('0')
    expect(picoToDecimalString(1000000000000n)).toBe('1')
    expect(picoToDecimalString(1234n)).toBe('0.000000001234') // 1234 pico
  })

  it('大数不丢精度', () => {
    expect(decimalToPico('123456789.123456789')).toBe(123456789123456789000n)
  })

  it('picoToDecimalString 去掉末尾零', () => {
    expect(picoToDecimalString(500000000000n)).toBe('0.5')
    expect(picoToDecimalString(1000000n)).toBe('0.000001')
  })
})
