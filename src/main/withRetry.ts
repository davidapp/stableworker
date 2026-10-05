/**
 * 请求韧性：指数退避重试（对齐 Claude Code 的 withRetry 策略，参数按桌面应用收敛）。
 *
 * - 可重试：HTTP 429 / 5xx / 529、网络层错误（fetch failed、ECONNRESET 等）
 * - 不可重试：4xx 客户端错误（重试也不会好）、用户中止（signal）
 * - 退避：800ms × 2ⁿ 封顶 12s，±10% 抖动；服务端给了 Retry-After 且 ≤30s 时优先尊重
 * - onRetry 回调把每次重试的原因与等待时间推给界面
 */

export class HttpError extends Error {
  /** HTTP 状态码 */
  readonly status: number
  /** 服务端 Retry-After 头换算的毫秒数（若有） */
  readonly retryAfterMs?: number

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** 这些状态码重试有意义 */
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))
}

export interface RetryInfo {
  /** 即将进行的重试序号（1 起） */
  attempt: number
  maxRetries: number
  waitMs: number
  reason: string
}

export interface RetryOptions<T> {
  maxRetries?: number
  signal?: AbortSignal
  /** 判定一个错误是否值得重试；不设则全部重试 */
  shouldRetry?: (err: unknown) => boolean
  /** 每次决定重试时回调（用于界面提示） */
  onRetry?: (info: RetryInfo) => Promise<void> | void
  /** fn 的第一个参数是当前尝试序号（1 起） */
  fn: (attempt: number) => Promise<T>
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(t)
        reject(new Error('aborted'))
      }
      if (signal.aborted) {
        clearTimeout(t)
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export async function withRetry<T>(opts: RetryOptions<T>): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4
  let attempt = 0
  while (true) {
    attempt++
    try {
      return await opts.fn(attempt)
    } catch (err) {
      if (opts.signal?.aborted) throw err
      const retryable = opts.shouldRetry ? opts.shouldRetry(err) : !isAbortError(err)
      if (!retryable || attempt > maxRetries) throw err

      let waitMs = Math.min(800 * 2 ** (attempt - 1), 12_000) * (0.9 + Math.random() * 0.2)
      const retryAfterMs = err instanceof HttpError ? err.retryAfterMs : undefined
      if (retryAfterMs != null && retryAfterMs <= 30_000) waitMs = retryAfterMs

      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 160)
      if (opts.onRetry) {
        await opts.onRetry({ attempt, maxRetries, waitMs: Math.round(waitMs), reason })
      }
      await sleep(Math.round(waitMs), opts.signal)
    }
  }
}
