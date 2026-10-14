import { parentPort, workerData } from 'node:worker_threads'
import { calculateWorkbookCore } from './officeFormulaCore'

if (!parentPort) throw new Error('公式计算只能在工作线程执行')
calculateWorkbookCore(Buffer.from(workerData.buffer)).then(({ buffer, report }) => {
  const bytes = Uint8Array.from(buffer)
  parentPort!.postMessage({ buffer: bytes, report }, [bytes.buffer])
}).catch((error: unknown) => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }))
