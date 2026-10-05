import { afterEach, describe, expect, it, vi } from 'vitest'
import { withRetry, HttpError } from '../src/main/withRetry'

afterEach(() => {
  vi.useRealTimers()
})

describe('withRetry 请求韧性', () => {
  it('首次成功不重试', async () => {
    let calls = 0
    const r = await withRetry({
      fn: async () => {
        calls++
        return 'ok'
      },
    })
    expect(r).toBe('ok')
    expect(calls).toBe(1)
  })

  it('可重试错误：退避后成功（fake timers 加速）', async () => {
    vi.useFakeTimers()
    let calls = 0
    const p = withRetry({
      maxRetries: 4,
      fn: async () => {
        calls++
        if (calls < 3) throw new HttpError('HTTP 500', 500)
        return 'ok'
      },
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await p).toBe('ok')
    expect(calls).toBe(3)
  })

  it('400 客户端错误立即抛出（不重试）', async () => {
    let calls = 0
    await expect(
      withRetry({
        maxRetries: 4,
        fn: async () => {
          calls++
          throw new HttpError('HTTP 400', 400)
        },
      }),
    ).rejects.toThrow('HTTP 400')
    expect(calls).toBe(1)
  })

  it('超过 maxRetries 后抛出最后一次错误', async () => {
    let calls = 0
    await expect(
      withRetry({
        maxRetries: 2,
        fn: async () => {
          calls++
          throw new HttpError('HTTP 503', 503)
        },
      }),
    ).rejects.toThrow('HTTP 503')
    expect(calls).toBe(3) // 首次 + 2 次重试
  })

  it('429 携带 Retry-After 时优先尊重', async () => {
    vi.useFakeTimers()
    let calls = 0
    const waits: number[] = []
    const p = withRetry({
      maxRetries: 4,
      fn: async () => {
        calls++
        if (calls === 1) throw new HttpError('HTTP 429', 429, 3000)
        return 'ok'
      },
      onRetry: (i) => {
        waits.push(i.waitMs)
      },
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await p).toBe('ok')
    expect(waits).toEqual([3000])
  })

  it('用户中止（signal 已 abort）不再重试', async () => {
    const ac = new AbortController()
    ac.abort()
    let calls = 0
    await expect(
      withRetry({
        maxRetries: 4,
        signal: ac.signal,
        fn: async () => {
          calls++
          throw new HttpError('HTTP 500', 500)
        },
        shouldRetry: () => true,
      }),
    ).rejects.toThrow('HTTP 500')
    expect(calls).toBe(1)
  })
})
