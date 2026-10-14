import { open, rm } from 'node:fs/promises'
import { MAX_OFFICE_FILE_BYTES, resolveOfficeFile } from './office'

/** Shared commit path: never overwrite originals or existing outputs; remove aborted partial files. */
export async function writeOfficeOutput(root: string, path: string, buffer: Buffer, signal?: AbortSignal): Promise<void> {
  if (!path.startsWith('outputs/')) throw new Error('结果必须写入 outputs/，不能覆盖导入资料')
  if (buffer.length > MAX_OFFICE_FILE_BYTES) throw new Error('结果文件超过 25 MB 上限')
  signal?.throwIfAborted()
  const abs = await resolveOfficeFile(root, path, true)
  signal?.throwIfAborted()
  const file = await open(abs, 'wx')
  try {
    await file.writeFile(buffer, { signal })
    signal?.throwIfAborted()
  } catch (error) {
    await file.close()
    await rm(abs, { force: true })
    throw error
  }
  await file.close()
}
