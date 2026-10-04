import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Session, SessionMeta } from '../shared/types'

/**
 * 会话存储：每个会话一个 JSON 文件，位于 userData/sessions/<projectId>/<sessionId>.json
 * 说明：Claude Code 用 append-only JSONL（天然可恢复、可追加），我们先用整文件 JSON
 * 保持简单；等消息量变大再迁移到 JSONL，是一个很好的后续练习。
 */

function projectDir(projectId: string): string {
  return join(app.getPath('userData'), 'sessions', projectId)
}

function sessionPath(projectId: string, sessionId: string): string {
  return join(projectDir(projectId), `${sessionId}.json`)
}

async function saveSessionFile(session: Session): Promise<void> {
  const dir = projectDir(session.projectId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf-8')
}

export function registerSessionHandlers(): void {
  ipcMain.handle('sessions:list', async (_e, projectId: string): Promise<SessionMeta[]> => {
    try {
      const dir = projectDir(projectId)
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
      const metas = await Promise.all(
        files.map(async (f) => {
          try {
            const s = JSON.parse(await readFile(join(dir, f), 'utf-8')) as Session
            return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt }
          } catch {
            return null // 单个文件损坏不拖垮整个列表
          }
        }),
      )
      return metas
        .filter((m): m is SessionMeta => m !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return [] // 目录不存在 = 该项目还没有会话
    }
  })

  ipcMain.handle('sessions:create', async (_e, projectId: string, title: string): Promise<Session> => {
    const session: Session = {
      id: randomUUID(),
      projectId,
      title: title || '新会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    }
    await saveSessionFile(session)
    return session
  })

  ipcMain.handle('sessions:load', async (_e, projectId: string, sessionId: string): Promise<Session | null> => {
    try {
      return JSON.parse(await readFile(sessionPath(projectId, sessionId), 'utf-8')) as Session
    } catch {
      return null
    }
  })

  ipcMain.handle('sessions:save', async (_e, session: Session): Promise<boolean> => {
    await saveSessionFile(session)
    return true
  })

  ipcMain.handle('sessions:delete', async (_e, projectId: string, sessionId: string): Promise<boolean> => {
    await rm(sessionPath(projectId, sessionId), { force: true })
    return true
  })
}

/** 供 projects:remove 调用：删掉某项目的全部会话记录 */
export async function deleteProjectSessions(projectId: string): Promise<void> {
  await rm(projectDir(projectId), { recursive: true, force: true })
}
