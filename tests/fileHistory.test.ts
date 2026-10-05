import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotFilesBeforeChange, restoreSnapshot } from '../src/main/fileHistory'

let root: string
let project: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sw-ckpt-root-'))
  project = await mkdtemp(join(tmpdir(), 'sw-ckpt-proj-'))
  await writeFile(join(project, 'a.txt'), '原始内容 v1')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('文件检查点', () => {
  it('快照 → 修改 → 回滚恢复原文', async () => {
    await snapshotFilesBeforeChange(root, 'tu-1', project, ['a.txt'])
    await writeFile(join(project, 'a.txt'), '被 AI 改过的内容')
    const r = await restoreSnapshot(root, 'tu-1', project)
    expect(r.restored).toEqual(['a.txt'])
    expect(await readFile(join(project, 'a.txt'), 'utf-8')).toBe('原始内容 v1')
  })

  it('新建文件回滚时被删除', async () => {
    await snapshotFilesBeforeChange(root, 'tu-2', project, ['new.txt']) // 文件不存在
    await writeFile(join(project, 'new.txt'), 'AI 新建的')
    const r = await restoreSnapshot(root, 'tu-2', project)
    expect(r.deleted).toEqual(['new.txt'])
    await expect(readFile(join(project, 'new.txt'))).rejects.toThrow()
  })

  it('回滚前会快照当前状态（可撤销本次回滚）', async () => {
    await snapshotFilesBeforeChange(root, 'tu-3', project, ['a.txt'])
    await writeFile(join(project, 'a.txt'), 'AI 的修改')
    await restoreSnapshot(root, 'tu-3', project) // 回滚 → v1
    // 此时当前状态是 v1；再回滚 undo 快照 → 回到 "AI 的修改"
    const undoDir = (await readdir(root)).find((d) => d.startsWith('restore-'))
    expect(undoDir).toBeTruthy()
    const r2 = await restoreSnapshot(root, undoDir as string, project)
    expect(r2.restored).toEqual(['a.txt'])
    expect(await readFile(join(project, 'a.txt'), 'utf-8')).toBe('AI 的修改')
  })

  it('越界路径不快照（不创建任何目录）', async () => {
    await snapshotFilesBeforeChange(root, 'tu-4', project, ['../outside.txt'])
    // 没有有效条目 → 不创建 tu-4 快照目录
    expect(await readdir(root)).toEqual([])
  })

  it('快照超过 100 份时滚动淘汰', async () => {
    for (let i = 0; i < 103; i++) {
      await snapshotFilesBeforeChange(root, `snap-${String(i).padStart(3, '0')}`, project, ['a.txt'])
    }
    const dirs = (await readdir(root)).length
    expect(dirs).toBe(100)
    // 最旧的被淘汰
    await expect(stat(join(root, 'snap-000'))).rejects.toThrow()
    expect(await stat(join(root, 'snap-102'))).toBeTruthy()
  })
})
