import { decimalToPico, picoToDecimalString } from '../shared/money'
import type { ModelPricing, Money } from '../shared/types'

/**
 * 计费辅助：DeepSeek 式的分时（高峰/空闲）× 缓存命中/未命中价格。
 * 单价单位统一为"本币 / 每百万 tokens"。
 *
 * 时段规则（北京时间）：周一至周五、非法定节假日的 09:00–12:00 与 14:00–18:00 为高峰；
 * 其余（晚间、周末、法定节假日全天）为空闲。请求按"发起时刻"定档。
 */

/** 中国法定节假日（北京时间日期）。以国务院每年公告为准；保存在 config.json 的 holidays 字段，可增删 */
export const DEFAULT_HOLIDAYS: string[] = [
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07', // 2026 国庆节
]

/** 判断给定时刻（北京时间）是否为高峰时段 */
export function isPeakTime(date: Date, holidays: string[]): boolean {
  // 北京时间 = UTC+8；中国无夏令时，固定偏移即可
  const bj = new Date(date.getTime() + 8 * 3_600_000)
  const day = bj.getUTCDay()
  if (day === 0 || day === 6) return false // 周末全天空闲
  const iso = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`
  if (holidays.includes(iso)) return false // 法定节假日全天空闲
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/**
 * 精确计算一次调用的费用（无浮点参与）。
 * 用 BigInt 以 1e-12（pico）为单位累加：费用 = Σ tokens × 单价 / 1_000_000，
 * 即 tokens × (单价×1e12) / 1e6。单价 ≤6 位小数时整除，结果精确不四舍五入。
 */
export function computeCost(input: {
  pricing: ModelPricing
  peak: boolean
  inputHit: number | null
  inputMiss: number | null
  output: number | null
}): Money | null {
  const { pricing, peak, inputHit, inputMiss, output } = input
  if (inputHit == null && inputMiss == null && output == null) return null

  const hitPrice = peak ? pricing.inputCacheHitPeak : pricing.inputCacheHitOffPeak
  const missPrice = peak ? pricing.inputCacheMissPeak : pricing.inputCacheMissOffPeak
  const outPrice = peak ? pricing.outputPeak : pricing.outputOffPeak

  let pico = 0n
  if (inputHit != null) pico += BigInt(inputHit) * decimalToPico(String(hitPrice))
  if (inputMiss != null) pico += BigInt(inputMiss) * decimalToPico(String(missPrice))
  if (output != null) pico += BigInt(output) * decimalToPico(String(outPrice))

  return {
    currency: pricing.currency,
    amount: picoToDecimalString(pico / 1_000_000n),
    source: 'estimated',
  }
}
