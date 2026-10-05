import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, readdir, rm, appendFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { deleteSessionCheckpoints, deleteProjectCheckpoints } from './fileHistory'
import { invalidateCompactCache, setCachedCompact } from './compact'
import { loadConfig } from './config'
import type { ChatMessage, Session, SessionMeta } from '../shared/types'

/**
 * 会话存储 v2：append-only JSONL（借鉴 Claude Code 的 sessionStorage）。
 *
 * 每个会话一个 <sessionId>.jsonl，每行一个操作，只追加、永不重写整文件：
 *   {"t":"meta","ts":...,"title":"...","createdAt":...}   标题/创建时间（新建、重命名时追加）
 *   {"t":"m","ts":...,"i":3,"m":{...}}                    把第 i 条消息设置为 m（追加或原地替换）
 *   {"t":"clear","ts":...}                                清空消息（🧹 清空上下文）
 *
 * 为什么这样做：
 * - 写入是 O(新内容) 的尾部追加，不再每次整文件重写
 * - 崩溃时最多损失最后半行——解析失败的行直接跳过，会话其余部分完好
 * - 回放是幂等的（按 index 覆盖），重复行无害
 *
 * 旧版单 JSON 文件（<id>.json）在 list/load 时自动转换成 JSONL 并删除原文件。
 */

function projectDir(projectId: string): string {
  return join(app.getPath('userData'), 'sessions', projectId)
}

function sessionFile(projectId: string, sessionId: string): string {
  return join(projectDir(projectId), `${sessionId}.jsonl`)
}

function legacyFile(projectId: string, sessionId: string): string {
  return join(projectDir(projectId), `${sessionId}.json`)
}

/** 旧版本（v0.x 单 JSON）里消息是 content: string，统一迁移成 blocks 结构 */
function normalizeMessage(m: ChatMessage): ChatMessage {
  if (Array.isArray(m.blocks)) return m
  const legacy = m as unknown as { content?: string }
  return {
    id: m.id,
    role: m.role,
    createdAt: m.createdAt,
    streaming: m.streaming,
    error: m.error,
    blocks: [{ type: 'text', text: String(legacy.content ?? '') }],
  }
}

// ---------- JSONL 读写 ----------

async function readLines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf-8')).split('\n').filter((l) => l.trim() !== '')
  } catch {
    return []
  }
}

async function appendLines(file: string, lines: unknown[]): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  await appendFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
}

interface ReplayResult {
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  exists: boolean
  /** 无法解析的行数（崩溃 / 磁盘问题导致的残缺） */
  corruptLines: number
  /** 文件总行数 */
  totalLines: number
  /** 最近的摘要压缩记录（clear 之后作废） */
  summary?: { droppedCount: number; text: string; ts: number }
}

/** 逐行回放一个 JSONL 文件；解析失败的行（崩溃残尾）跳过但计数，供损坏告警 */
async function replay(projectId: string, sessionId: string): Promise<ReplayResult> {
  const result: ReplayResult = {
    title: '新会话',
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    exists: false,
    corruptLines: 0,
    totalLines: 0,
  }
  const lines = await readLines(sessionFile(projectId, sessionId))
  if (lines.length === 0) return result
  result.exists = true
  result.totalLines = lines.length
  for (const line of lines) {
    let o: {
      t?: string
      ts?: number
      title?: string
      createdAt?: number
      i?: number
      m?: ChatMessage
      droppedCount?: number
      text?: string
    }
    try {
      o = JSON.parse(line)
    } catch {
      result.corruptLines++
      continue
    }
    const ts = typeof o.ts === 'number' ? o.ts : 0
    if (ts > result.updatedAt) result.updatedAt = ts
    if (o.t === 'meta') {
      if (o.title) result.title = o.title
      if (o.createdAt && !result.createdAt) result.createdAt = o.createdAt
    } else if (o.t === 'm' && o.m && typeof o.i === 'number') {
      result.messages[o.i] = normalizeMessage(o.m)
    } else if (o.t === 'clear') {
      result.messages.length = 0
      result.summary = undefined // 清空后旧摘要不再适用
    } else if (o.t === 'summary' && typeof o.droppedCount === 'number' && typeof o.text === 'string') {
      result.summary = { droppedCount: o.droppedCount, text: o.text, ts }
    }
  }
  return result
}

// ---------- 已知状态缓存：save 时只追加真正变化的消息 ----------

const knownMessages = new Map<string, ChatMessage[]>()

const cacheKey = (projectId: string, sessionId: string): string => `${projectId}/${sessionId}`

// ---------- 旧格式迁移 ----------

async function migrateLegacy(projectId: string, sessionId: string): Promise<Session | null> {
  try {
    const legacy = JSON.parse(await readFile(legacyFile(projectId, sessionId), 'utf-8')) as Session
    const messages = (legacy.messages ?? []).map(normalizeMessage)
    const lines: unknown[] = [
      { t: 'meta', ts: legacy.createdAt, title: legacy.title, createdAt: legacy.createdAt },
      ...messages.map((m, i) => ({ t: 'm', ts: legacy.updatedAt, i, m })),
    ]
    await appendLines(sessionFile(projectId, sessionId), lines)
    await rm(legacyFile(projectId, sessionId)) // 转换完成才删旧文件
    return { ...legacy, messages }
  } catch {
    return null
  }
}

export async function loadSessionAny(
  projectId: string,
  sessionId: string,
): Promise<{ session: Session | null; damaged: boolean; corruptLines: number; totalLines: number }> {
  const r = await replay(projectId, sessionId)
  const damaged = r.exists && r.corruptLines > 0
  if (r.exists) {
    const session: Session = {
      id: sessionId,
      projectId,
      title: r.createdAt || r.messages.length ? r.title : '（损坏的会话）',
      createdAt: r.createdAt || r.updatedAt,
      updatedAt: r.updatedAt,
      messages: r.messages,
      summary: r.summary,
    }
    knownMessages.set(cacheKey(projectId, sessionId), r.messages)
    // 恢复摘要缓存：重启后同会话继续压缩时直接复用，不再花摘要 API 调用
    if (r.summary) setCachedCompact(sessionId, r.summary.droppedCount, r.summary.text)
    return { session, damaged, corruptLines: r.corruptLines, totalLines: r.totalLines }
  }
  const legacy = await migrateLegacy(projectId, sessionId)
  if (legacy) {
    knownMessages.set(cacheKey(projectId, sessionId), legacy.messages)
    return { session: legacy, damaged: false, corruptLines: 0, totalLines: 0 }
  }
  return { session: null, damaged: false, corruptLines: 0, totalLines: 0 }
}

// ---------- IPC ----------

/** 列出某项目全部会话元数据（JSONL 与旧格式都算），按 updatedAt 倒序 */
export async function listSessionMetas(projectId: string): Promise<SessionMeta[]> {
  try {
    const dir = projectDir(projectId)
    const files = await readdir(dir).catch(() => [] as string[])
    const ids = new Set<string>()
    for (const f of files) {
      if (f.endsWith('.jsonl')) ids.add(f.slice(0, -'.jsonl'.length))
      else if (f.endsWith('.json')) ids.add(f.slice(0, -'.json'.length))
    }
    const metas: SessionMeta[] = []
    for (const id of ids) {
      const r = await loadSessionAny(projectId, id)
      if (r.session) {
        metas.push({
          id: r.session.id,
          title: r.session.title,
          createdAt: r.session.createdAt,
          updatedAt: r.session.updatedAt,
          damaged: r.damaged || undefined,
        })
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return [] // 目录不存在 = 该项目还没有会话
  }
}

/** 外部修改会话后广播给所有窗口（主窗口据此重载，防止旧内存状态覆盖磁盘） */
export function emitSessionsChanged(projectId: string, sessionId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('sessions:changed', { projectId, sessionId })
  }
}

export function registerSessionHandlers(): void {
  // 外部（上下文管理窗口等）修改会话后广播：主窗口据此从磁盘重载，
  // 避免主窗口的旧内存状态在下一次保存时覆盖外部修改
  ipcMain.handle('sessions:current', async (): Promise<{ projectId: string; sessionId: string; title: string } | null> => {
    const cfg = await loadConfig()
    const projectId = cfg.activeProjectId
    if (!projectId) return null
    const sessions = await listSessionMetas(projectId)
    const latest = sessions[0]
    if (!latest) return null
    return { projectId, sessionId: latest.id, title: latest.title }
  })

  ipcMain.handle('sessions:list', async (_e, projectId: string): Promise<SessionMeta[]> => {
    return listSessionMetas(projectId)
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
    await appendLines(sessionFile(projectId, session.id), [
      { t: 'meta', ts: session.updatedAt, title: session.title, createdAt: session.createdAt },
    ])
    knownMessages.set(cacheKey(projectId, session.id), [])
    return session
  })

  ipcMain.handle('sessions:load', async (_e, projectId: string, sessionId: string) => {
    return loadSessionAny(projectId, sessionId)
  })

  registerSaveAndEditHandlers()

  // 在资源管理器中显示会话文件（损坏恢复引导用）
  ipcMain.handle('sessions:reveal', async (_e, projectId: string, sessionId: string): Promise<boolean> => {
    const file = sessionFile(projectId, sessionId)
    shell.showItemInFolder(file)
    return true
  })

  ipcMain.handle('sessions:delete', async (_e, projectId: string, sessionId: string): Promise<boolean> => {
    await rm(sessionFile(projectId, sessionId), { force: true })
    await rm(legacyFile(projectId, sessionId), { force: true })
    await deleteSessionCheckpoints(projectId, sessionId) // 检查点连带清理
    knownMessages.delete(cacheKey(projectId, sessionId))
    invalidateCompactCache(sessionId) // 摘要缓存一并失效
    return true
  })

  // 重命名会话：追加一条 meta（列表排序用的 updatedAt 不变，保持原位）
  ipcMain.handle(
    'sessions:rename',
    async (_e, projectId: string, sessionId: string, title: string): Promise<boolean> => {
      await appendLines(sessionFile(projectId, sessionId), [{ t: 'meta', ts: Date.now(), title }])
      return true
    },
  )
}

/** 追加摘要压缩记录（llm.ts 摘要生成成功后调用，随会话文件持久化） */
export async function appendSummaryLine(
  projectId: string,
  sessionId: string,
  droppedCount: number,
  text: string,
): Promise<void> {
  await mkdir(projectDir(projectId), { recursive: true })
  await appendLines(sessionFile(projectId, sessionId), [
    { t: 'summary', ts: Date.now(), droppedCount, text },
  ])
}

/** 供 projects:remove 调用：删掉某项目的全部会话记录 */
export async function deleteProjectSessions(projectId: string): Promise<void> {
  await rm(projectDir(projectId), { recursive: true, force: true })
  await deleteProjectCheckpoints(projectId) // 检查点连带清理
}

/**
 * 全量保存内部实现：与已知状态 diff 后只追加变化。
 * - 新消息追加；已有消息按 index 覆盖（编辑/删除消息场景）
 * - 消息数变少（中间删除）时追加 clear + 全量重写（保证索引不残留旧消息）
 * - 写入失败重试一次，仍失败把错误带回调用方
 */
export async function saveSessionInternal(session: Session): Promise<{ ok: boolean; error?: string }> {
  const file = sessionFile(session.projectId, session.id)
  const key = cacheKey(session.projectId, session.id)
  const known = knownMessages.get(key)

  const attempt = async (): Promise<void> => {
    await mkdir(projectDir(session.projectId), { recursive: true })

    let lines: unknown[]
    if (!known) {
      // 内存里没有该会话的状态（如应用重启后首次保存）：整段补写（回放幂等，结果正确）
      lines = [
        { t: 'meta', ts: session.updatedAt, title: session.title, createdAt: session.createdAt },
        ...session.messages.map((m, i) => ({ t: 'm', ts: session.updatedAt, i, m })),
      ]
    } else if (session.messages.length === 0) {
      lines = known.length > 0 ? [{ t: 'clear', ts: Date.now() }] : []
      if (lines.length > 0) invalidateCompactCache(session.id) // 清空后旧摘要作废
    } else if (known.length > session.messages.length) {
      // 中间删除：clear 后整段重写（回放幂等，结果正确）
      invalidateCompactCache(session.id)
      lines = [
        { t: 'clear', ts: session.updatedAt },
        { t: 'meta', ts: session.updatedAt, title: session.title },
        ...session.messages.map((m, i) => ({ t: 'm', ts: session.updatedAt, i, m })),
      ]
    } else {
      lines = []
      for (let i = 0; i < session.messages.length; i++) {
        if (!known[i] || JSON.stringify(known[i]) !== JSON.stringify(session.messages[i])) {
          lines.push({ t: 'm', ts: session.updatedAt, i, m: session.messages[i] })
        }
      }
    }
    if (lines.length > 0) await appendLines(file, lines)
  }

  const attemptWithRetry = async (): Promise<void> => {
    try {
      await attempt()
    } catch (first) {
      await new Promise((r) => setTimeout(r, 300)) // 短暂等待后重试一次（同步工具占用等瞬时问题）
      try {
        await attempt()
      } catch (second) {
        const detail = second instanceof Error ? second.message : String(second)
        throw new Error(`${detail}（首次错误：${first instanceof Error ? first.message : String(first)}）`)
      }
    }
  }

  try {
    await attemptWithRetry()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  knownMessages.set(key, session.messages)
  return { ok: true }
}

/** 注册消息编辑 / 删除处理器（上下文管理窗口用） */
function registerSaveAndEditHandlers(): void {
  ipcMain.handle('sessions:save', async (_e, session: Session): Promise<{ ok: boolean; error?: string }> => {
    return saveSessionInternal(session)
  })

  // 编辑一条历史消息：替换其第一个文本块（reasoning / tool_use 块原样保留）
  ipcMain.handle(
    'sessions:editMessage',
    async (_e, projectId: string, sessionId: string, messageId: string, text: string): Promise<boolean> => {
      const { session } = await loadSessionAny(projectId, sessionId)
      if (!session) return false
      const idx = session.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return false
      const m = session.messages[idx]
      let replaced = false
      const blocks = m.blocks.map((b) => {
        if (b.type !== 'text' || replaced) return b
        replaced = true
        return { type: 'text' as const, text }
      })
      if (!replaced) blocks.unshift({ type: 'text', text })
      session.messages[idx] = { ...m, blocks }
      invalidateCompactCache(sessionId) // 内容变了，旧摘要可能过时
      const r = await saveSessionInternal(session)
      if (r.ok) emitSessionsChanged(projectId, sessionId)
      return r.ok
    },
  )

  // 删除一条历史消息（中间删除触发 clear + 整段重写，保证索引不残留）
  ipcMain.handle(
    'sessions:deleteMessage',
    async (_e, projectId: string, sessionId: string, messageId: string): Promise<boolean> => {
      const { session } = await loadSessionAny(projectId, sessionId)
      if (!session) return false
      const idx = session.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return false
      session.messages.splice(idx, 1)
      invalidateCompactCache(sessionId)
      const r = await saveSessionInternal(session)
      if (r.ok) emitSessionsChanged(projectId, sessionId)
      return r.ok
    },
  )

  // 按 id 清空某个会话的上下文（独立上下文管理窗口用，无需依赖主窗口状态）
  ipcMain.handle(
    'sessions:clearById',
    async (_e, projectId: string, sessionId: string): Promise<boolean> => {
      const { session } = await loadSessionAny(projectId, sessionId)
      if (!session) return false
      session.messages = []
      session.summary = undefined
      invalidateCompactCache(sessionId)
      const r = await saveSessionInternal(session)
      if (r.ok) emitSessionsChanged(projectId, sessionId)
      return r.ok
    },
  )
}
