import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Windows 上 fs.symlink 需要管理员或"开发者模式"，否则 EPERM。
 * 符号链接类测试用本函数探测能力，不支持时跳过（本机无此能力不代表产品有缺陷）。
 */
export async function canSymlink(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'sw-symcheck-'))
  try {
    const a = join(dir, 'a')
    await writeFile(a, 'x')
    await symlink(a, join(dir, 'b'))
    return true
  } catch {
    return false
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
