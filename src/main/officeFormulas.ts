import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FormulaCalculationResult } from './officeFormulaCore'

export type { FormulaCalculationReport, FormulaCalculationResult } from './officeFormulaCore'

/** A terminated worker cannot produce a late workbook or block the Electron main thread. */
export async function calculateWorkbook(buffer: Buffer, signal?: AbortSignal): Promise<FormulaCalculationResult> {
  signal?.throwIfAborted()
  const bundled = join(__dirname, 'officeFormulaWorker.js')
  const unpacked = bundled.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  const path = existsSync(unpacked) ? unpacked : bundled
  if (!existsSync(path)) throw new Error('公式工作线程未构建，请运行 build 或从桌面应用启动')
  const worker = new Worker(path, { workerData: { buffer: Uint8Array.from(buffer) } })
  return new Promise<FormulaCalculationResult>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const finish = (error?: Error, result?: FormulaCalculationResult): void => {
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate().then(() => error ? reject(error) : resolve(result!)).catch(reject)
    }
    const onAbort = (): void => finish(new Error('公式计算已取消'))
    const timer = setTimeout(() => finish(new Error('公式计算超过 30 秒，工作线程已终止')), 30_000)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => { if (!settled) finish(new Error(`公式工作线程退出（${code}）`)) })
    worker.once('message', (message: { error?: string; buffer?: Uint8Array; report?: FormulaCalculationResult['report'] }) => {
      if (signal?.aborted) { onAbort(); return }
      if (message.error) finish(new Error(message.error))
      else if (!message.buffer || !message.report) finish(new Error('公式工作线程返回无效结果'))
      else finish(undefined, { buffer: Buffer.from(message.buffer), report: message.report })
    })
    if (signal?.aborted) onAbort()
  })
}
