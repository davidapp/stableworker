import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, readdir, rm, appendFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { deleteSessionCheckpoints, deleteProjectCheckpoints, restoreSnapshot, sessionCheckpointsRoot } from './fileHistory'
import { invalidateCompactCache, setCachedCompact } from './compact'
import { loadConfig } from './config'
import type { ChatMessage, Session, SessionChangeEvent, SessionMeta, SessionSaveResult, TaskMode } from '../shared/types'

/**
 * 会话存储 v2：append-only JSONL（借鉴 Claude Code 的 sessionStorage）。
 *
 * 每个会话一个 <sessionId>.jsonl。旧行是一条操作，新行是带 revision 的完整事务：
 *   {"t":"meta","ts":...,"title":"...","createdAt":...}   标题/创建时间（新建、重命名时追加）
 *   {"t":"m","ts":...,"i":3,"m":{...}}                    把第 i 条消息设置为 m（追加或原地替换）
 *   {"t":"clear","ts":...}                                清空消息（🧹 清空上下文）
 *   {"t":"batch","revision":1,"operations":[...]}          原子回放的版本化修改
 *
 * 为什么这样做：
 * - 写入是 O(新内容) 的尾部追加，不再每次整文件重写
 * - 崩溃时最多损失最后半行——解析失败的行直接跳过，会话其余部分完好
 * - 回放是幂等的（按 index 覆盖，同 revision 事务跳过），重复行无害
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
  // Separate a possible crash-truncated tail from the next committed JSONL row.
  await appendFile(file, '\n' + lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
}

const writeQueues = new Map<string, Promise<unknown>>()
const deletedSessions = new Set<string>()
const cacheKey = (projectId: string, sessionId: string): string => `${projectId}/${sessionId}`

function serializeSession<T>(projectId: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
  const key = cacheKey(projectId, sessionId)
  const current = (writeQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
  writeQueues.set(key, current)
  void current.finally(() => { if (writeQueues.get(key) === current) writeQueues.delete(key) }).catch(() => {})
  return current
}

interface SessionOperation {
  t: string
  ts?: number
  title?: string
  createdAt?: number
  taskMode?: TaskMode
  llmId?: string
  i?: number
  m?: ChatMessage
  droppedCount?: number
  text?: string
}

async function appendTransaction(file: string, revision: number, operations: SessionOperation[]): Promise<void> {
  // One complete JSON line is a transaction: a crash cannot replay half a clear/rewrite.
  await appendLines(file, [{ t: 'batch', revision, ts: Date.now(), operations }])
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
  revision: number
  taskMode: TaskMode
  llmId?: string
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
    revision: 0,
    taskMode: 'coding',
  }
  const lines = await readLines(sessionFile(projectId, sessionId))
  if (lines.length === 0) return result
  result.exists = true
  result.totalLines = lines.length
  const apply = (o: SessionOperation): void => {
    const ts = typeof o.ts === 'number' ? o.ts : 0
    if (ts > result.updatedAt) result.updatedAt = ts
    if (o.t === 'meta') {
      if (o.title) result.title = o.title
      if (o.createdAt && !result.createdAt) result.createdAt = o.createdAt
      if (o.taskMode === 'office' || o.taskMode === 'coding') result.taskMode = o.taskMode
      result.llmId = o.llmId // 后写的覆盖先写的；undefined（旧版无字段）也清掉
    } else if (o.t === 'm' && o.m && Number.isSafeInteger(o.i) && o.i! >= 0) {
      result.messages[o.i!] = normalizeMessage(o.m)
    } else if (o.t === 'clear') {
      result.messages.length = 0
      result.summary = undefined
    } else if (o.t === 'summary' && typeof o.droppedCount === 'number' && typeof o.text === 'string') {
      result.summary = o.text ? { droppedCount: o.droppedCount, text: o.text, ts } : undefined
    }
  }
  for (const line of lines) {
    let o: SessionOperation & { revision?: number; operations?: SessionOperation[] }
    try {
      o = JSON.parse(line)
    } catch {
      result.corruptLines++
      continue
    }
    if (o.t === 'batch') {
      if (!Number.isSafeInteger(o.revision) || o.revision! <= result.revision || !Array.isArray(o.operations)) continue
      o.operations.forEach(apply)
      result.revision = o.revision!
    } else {
      apply(o)
    }
  }
  return result
}

// ---------- 旧格式迁移 ----------

async function migrateLegacy(projectId: string, sessionId: string): Promise<Session | null> {
  try {
    const legacy = JSON.parse(await readFile(legacyFile(projectId, sessionId), 'utf-8')) as Session
    const messages = (legacy.messages ?? []).map(normalizeMessage)
    const taskMode = legacy.taskMode ?? 'coding'
    const lines: SessionOperation[] = [
      { t: 'meta', ts: legacy.createdAt, title: legacy.title, createdAt: legacy.createdAt, taskMode },
      ...messages.map((m, i) => ({ t: 'm', ts: legacy.updatedAt, i, m })),
      ...(legacy.summary ? [{ t: 'summary', ...legacy.summary }] : []),
    ]
    await appendTransaction(sessionFile(projectId, sessionId), 1, lines)
    await rm(legacyFile(projectId, sessionId)) // 转换完成才删旧文件
    return { ...legacy, messages, taskMode, revision: 1 }
  } catch {
    return null
  }
}

async function loadSessionUnlocked(
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
      revision: r.revision,
      taskMode: r.taskMode,
      llmId: r.llmId,
    }
    // 恢复摘要缓存：重启后同会话继续压缩时直接复用，不再花摘要 API 调用
    if (r.summary) setCachedCompact(sessionId, r.summary.droppedCount, r.summary.text)
    else invalidateCompactCache(sessionId)
    return { session, damaged, corruptLines: r.corruptLines, totalLines: r.totalLines }
  }
  const legacy = await migrateLegacy(projectId, sessionId)
  if (legacy) {
    return { session: legacy, damaged: false, corruptLines: 0, totalLines: 0 }
  }
  return { session: null, damaged: false, corruptLines: 0, totalLines: 0 }
}

export function loadSessionAny(projectId: string, sessionId: string): ReturnType<typeof loadSessionUnlocked> {
  return serializeSession(projectId, sessionId, () => loadSessionUnlocked(projectId, sessionId))
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
          taskMode: r.session.taskMode,
          llmId: r.session.llmId,
        })
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return [] // 目录不存在 = 该项目还没有会话
  }
}

/** 外部修改会话后广播给所有窗口（主窗口据此重载，防止旧内存状态覆盖磁盘） */
/** 打开会话事件：搜索窗口点击结果 → 主窗口跳转到该会话 */
export function emitSessionsOpen(projectId: string, sessionId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('sessions:open', { projectId, sessionId })
  }
}

export function emitSessionsChanged(projectId: string, sessionId: string, detail: Pick<SessionChangeEvent, 'revision' | 'change'> = {}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('sessions:changed', { projectId, sessionId, ...detail })
  }
}

/** 纯函数：计算回退计划（sessions:rewindTo 与测试共用） */
export function planRewind(
  messages: ChatMessage[],
  messageId: string,
): { ok: true; keepCount: number; removedCount: number; removedToolUseIds: string[] } | { ok: false; error: string } {
  const idx = messages.findIndex((m) => m.id === messageId)
  if (idx < 0) return { ok: false, error: '消息不存在（可能已被删除）' }
  const removed = messages.slice(idx + 1)
  const removedToolUseIds: string[] = []
  for (const m of removed) {
    for (const b of m.blocks) if (b.type === 'tool_use') removedToolUseIds.push(b.id)
  }
  return { ok: true, keepCount: idx + 1, removedCount: removed.length, removedToolUseIds }
}

/**
 * 纯函数：构建分叉会话（sessions:fork 与测试共用）。
 * 复制 messageId 及之前的全部消息为新会话（深拷贝，互不影响）；
 * 摘要不继承（可能引用被截掉的内容），标题加"· 分叉"后缀。
 */
export function buildForkSession(
  session: Session,
  messageId: string,
): { ok: true; session: Session } | { ok: false; error: string } {
  const plan = planRewind(session.messages, messageId)
  if (!plan.ok) return { ok: false, error: plan.error }
  const now = Date.now()
  return {
    ok: true,
    session: {
      ...session,
      id: randomUUID(),
      title: `${session.title} · 分叉`,
      createdAt: now,
      updatedAt: now,
      damaged: undefined,
      summary: undefined, // 摘要可能引用分叉点之后被截掉的内容，不继承
      messages: JSON.parse(JSON.stringify(session.messages.slice(0, plan.keepCount))) as ChatMessage[],
    },
  }
}

export function registerSessionHandlers(): void {
  // 全局搜索：跨项目扫描所有会话消息的文本（大小写不敏感子串），上限 50 条
  ipcMain.handle(
    'sessions:search',
    async (_e, query: string): Promise<{ projectId: string; sessionId: string; sessionTitle: string; role: string; text: string; updatedAt: number }[]> => {
      const q = query.trim().toLowerCase()
      if (!q) return []
      const cfg = await loadConfig()
      const out: { projectId: string; sessionId: string; sessionTitle: string; role: string; text: string; updatedAt: number }[] = []
      for (const p of cfg.projects ?? []) {
        const metas = await listSessionMetas(p.id)
        for (const meta of metas) {
          if (out.length >= 50) break
          const r = await loadSessionAny(p.id, meta.id)
          if (!r.session) continue
          for (const m of r.session.messages) {
            const text = m.blocks
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
            if (text.toLowerCase().includes(q)) {
              const at = text.toLowerCase().indexOf(q)
              out.push({
                projectId: p.id,
                sessionId: meta.id,
                sessionTitle: meta.title,
                role: m.role,
                text: text.slice(Math.max(0, at - 40), at + 80),
                updatedAt: meta.updatedAt,
              })
              if (out.length >= 50) break
            }
          }
        }
      }
      return out
    },
  )

  // 导出会话为 Markdown：保存对话框选择位置后写入
  ipcMain.handle(
    'sessions:exportMarkdown',
    async (_e, projectId: string, sessionId: string): Promise<{ ok: boolean; path?: string; error?: string }> => {
      try {
        const r = await loadSessionAny(projectId, sessionId)
        if (!r.session) return { ok: false, error: '会话不存在' }
        const parts = [`# 会话导出：${r.session.title}`, '', `- 导出时间：${new Date().toLocaleString()}`, `- 消息数：${r.session.messages.length}`, '']
        for (const m of r.session.messages) {
          const role = m.role === 'user' ? '👤 用户' : '🤖 助手'
          parts.push(`## ${role} · ${new Date(m.createdAt).toLocaleString()}`, '')
          for (const b of m.blocks) {
            if (b.type === 'text') parts.push(b.text, '')
            else if (b.type === 'tool_use') parts.push(`> 🛠 调用工具 \`${b.name}\`：\`${JSON.stringify(b.input).slice(0, 300)}\``, '')
          }
        }
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: '导出会话为 Markdown',
          defaultPath: `${r.session.title.replace(/[\\/:*?"<>|]/g, '_')}.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        })
        if (canceled || !filePath) return { ok: false, error: '已取消' }
        await writeFile(filePath, parts.join('\n'), 'utf-8')
        return { ok: true, path: filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // 打开会话（搜索窗口点击结果 → 主窗口跳转）
  ipcMain.handle('sessions:open', async (_e, projectId: string, sessionId: string): Promise<boolean> => {
    emitSessionsOpen(projectId, sessionId)
    return true
  })

  // 外部（上下文管理窗口等）修改会话后广播：主窗口据此从磁盘重载，  // 外部（上下文管理窗口等）修改会话后广播：主窗口据此从磁盘重载，
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

  ipcMain.handle('sessions:create', async (_e, projectId: string, title: string, taskMode: TaskMode = 'coding'): Promise<Session> => {
    const session: Session = {
      id: randomUUID(),
      projectId,
      title: title || '新会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      revision: 1,
      taskMode: taskMode === 'office' ? 'office' : 'coding',
    }
    await serializeSession(projectId, session.id, () => appendTransaction(sessionFile(projectId, session.id), 1, [
      { t: 'meta', ts: session.updatedAt, title: session.title, createdAt: session.createdAt, taskMode: session.taskMode },
    ]))
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
    await serializeSession(projectId, sessionId, async () => {
      const { session } = await loadSessionUnlocked(projectId, sessionId)
      let officeRoot: string | undefined
      if (projectId === 'office-workspace' || session?.taskMode === 'office') {
        const { ensureOfficeWorkspace } = await import('./office')
        // Validate every managed directory before deleting either records or files.
        officeRoot = await ensureOfficeWorkspace(sessionId)
      }
      await rm(sessionFile(projectId, sessionId), { force: true })
      await rm(legacyFile(projectId, sessionId), { force: true })
      deletedSessions.add(cacheKey(projectId, sessionId))
      if (officeRoot) await rm(officeRoot, { recursive: true, force: true })
      await deleteSessionCheckpoints(projectId, sessionId)
      invalidateCompactCache(sessionId)
    })
    emitSessionsChanged(projectId, sessionId, { change: 'deleted' })
    return true
  })

  // 消息级回退（对齐 Claude Code 的 /rewind）：保留 messageId 及之前，删除其后全部；
  // restoreFiles 时把被删范围内的文件修改按检查点逆序回放，恢复到该时点之前的状态
  ipcMain.handle(
    'sessions:rewindTo',
    async (
      _e,
      projectId: string,
      sessionId: string,
      messageId: string,
      restoreFiles: boolean,
    ): Promise<{ ok: boolean; error?: string; removedCount?: number; restoredFiles?: string[] }> => {
      const result = await serializeSession(projectId, sessionId, async () => {
        const { session } = await loadSessionUnlocked(projectId, sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const plan = planRewind(session.messages, messageId)
        if (!plan.ok) return { ok: false, error: plan.error }
        const removed = session.messages.slice(plan.keepCount)
        const removedToolUseIds = plan.removedToolUseIds
        session.messages = session.messages.slice(0, plan.keepCount)
        session.updatedAt = Date.now()
        const saved = await saveSessionUnlocked(session)
        if (!saved.ok) return { ok: false, error: saved.error ?? '会话写入失败' }
        let restoredFiles: string[] = []
        if (restoreFiles && removedToolUseIds.length > 0) {
          const cfg = await loadConfig()
          const projectPath = cfg.projects.find((p) => p.id === projectId)?.path
          if (projectPath) {
            const checkpointsRoot = sessionCheckpointsRoot(projectId, sessionId)
            // 逆序回放：每步把文件写回"该次修改前"，全部回放完 = 目标消息时点的状态；
            // 回放前 restoreSnapshot 会先把当前状态拍 restore- 快照，误回退可再撤销
            for (const toolUseId of [...removedToolUseIds].reverse()) {
              try {
                const r = await restoreSnapshot(checkpointsRoot, toolUseId, projectPath)
                restoredFiles.push(...r.restored, ...r.deleted)
              } catch {
                // 该调用无检查点（只读工具 / 未快照 / 已滚动淘汰），跳过
              }
            }
            restoredFiles = [...new Set(restoredFiles)]
          }
        }
        invalidateCompactCache(sessionId) // 上下文变了，旧摘要作废
        return { ok: true, removedCount: removed.length, restoredFiles }
      })
      if (result.ok) emitSessionsChanged(projectId, sessionId)
      return result
    },
  )

  // 会话分叉：复制 messageId 及之前的消息为新会话，原会话保持不变
  ipcMain.handle(
    'sessions:fork',
    async (
      _e,
      projectId: string,
      sessionId: string,
      messageId: string,
    ): Promise<{ ok: boolean; error?: string; newSessionId?: string }> => {
      const forked = await serializeSession(projectId, sessionId, async () => {
        const { session } = await loadSessionUnlocked(projectId, sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const built = buildForkSession(session, messageId)
        if (!built.ok) return built
        const saved = await saveSessionInternal(built.session)
        if (!saved.ok) return { ok: false, error: saved.error ?? '分叉会话写入失败' }
        return { ok: true, newSessionId: built.session.id }
      })
      if (forked.ok && forked.newSessionId) {
        emitSessionsChanged(projectId, forked.newSessionId, { change: 'metadata' })
      }
      return forked
    },
  )

  // 会话独立模型：llmId 传 null 表示跟随全局激活档
  ipcMain.handle(
    'sessions:setModel',
    async (_e, projectId: string, sessionId: string, llmId: string | null): Promise<boolean> => {
      const result = await serializeSession(projectId, sessionId, async () => {
        const { session } = await loadSessionUnlocked(projectId, sessionId)
        if (!session) return false
        session.llmId = llmId && llmId.trim() ? llmId.trim() : undefined
        session.updatedAt = Date.now()
        return (await saveSessionUnlocked(session)).ok
      })
      if (result) emitSessionsChanged(projectId, sessionId, { change: 'metadata' })
      return result === true
    },
  )

  // 重命名会话：追加一条 meta（列表排序用的 updatedAt 不变，保持原位）
  ipcMain.handle(
    'sessions:rename',
    async (_e, projectId: string, sessionId: string, title: string): Promise<boolean> => {
      const result = await serializeSession(projectId, sessionId, async () => {
        const { session } = await loadSessionUnlocked(projectId, sessionId)
        if (!session) return { ok: false } as SessionSaveResult
        return saveSessionUnlocked({ ...session, title, updatedAt: Date.now() })
      })
      if (result.ok) emitSessionsChanged(projectId, sessionId, { revision: result.revision, change: 'metadata' })
      return result.ok
    },
  )
}

/** 追加摘要压缩记录（llm.ts 摘要生成成功后调用，随会话文件持久化） */
export async function appendSummaryLine(
  projectId: string,
  sessionId: string,
  droppedCount: number,
  text: string,
  expectedRevision?: number,
): Promise<SessionSaveResult> {
  return serializeSession(projectId, sessionId, async () => {
    const { session } = await loadSessionUnlocked(projectId, sessionId)
    if (!session || deletedSessions.has(cacheKey(projectId, sessionId))) return { ok: false, error: '会话已不存在' }
    const revision = session.revision ?? 0
    if (expectedRevision !== undefined && expectedRevision !== revision) return conflict(revision)
    try {
      await appendTransaction(sessionFile(projectId, sessionId), revision + 1, [
        { t: 'summary', ts: Date.now(), droppedCount, text },
      ])
      if (text) setCachedCompact(sessionId, droppedCount, text)
      else invalidateCompactCache(sessionId)
      emitSessionsChanged(projectId, sessionId, { revision: revision + 1, change: 'summary' })
      return { ok: true, revision: revision + 1 }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
}

/** 供 projects:remove 调用：删掉某项目的全部会话记录 */
export async function deleteProjectSessions(projectId: string): Promise<void> {
  await rm(projectDir(projectId), { recursive: true, force: true })
  await deleteProjectCheckpoints(projectId) // 检查点连带清理
}

/**
 * 全量保存内部实现：在同会话队列内读取权威版本，CAS 后只追加变化。
 * - 新消息追加；已有消息按 index 覆盖（编辑/删除消息场景）
 * - 消息数变少（中间删除）时追加 clear + 全量重写（保证索引不残留旧消息）
 * - 完整事务作为一个 JSONL 行写入；写入失败重试一次
 */
function conflict(revision: number): SessionSaveResult {
  return { ok: false, conflict: true, revision, error: '会话已在其他窗口修改，请刷新后再保存；旧内容未覆盖新版本' }
}

async function saveSessionUnlocked(session: Session): Promise<SessionSaveResult> {
  const key = cacheKey(session.projectId, session.id)
  const { session: stored } = await loadSessionUnlocked(session.projectId, session.id)
  const revision = stored?.revision ?? 0
  if (deletedSessions.has(key) || (session.revision ?? 0) !== revision) return conflict(revision)
  const known = stored?.messages ?? []
  const taskMode = session.taskMode ?? stored?.taskMode ?? 'coding'
  const ts = session.updatedAt
  const lines: SessionOperation[] = []
  if (!stored || stored.title !== session.title || stored.taskMode !== taskMode || stored.llmId !== session.llmId) {
    lines.push({ t: 'meta', ts, title: session.title, createdAt: session.createdAt, taskMode, llmId: session.llmId })
  }
  if (known.length > session.messages.length) {
    lines.push({ t: 'clear', ts }, ...session.messages.map((m, i) => ({ t: 'm', ts, i, m })))
  } else {
    for (let i = 0; i < session.messages.length; i++) {
      if (!known[i] || JSON.stringify(known[i]) !== JSON.stringify(session.messages[i])) {
        lines.push({ t: 'm', ts, i, m: session.messages[i] })
      }
    }
  }
  const summaryInvalidated = stored?.summary && (
    known.length > session.messages.length ||
    known.slice(0, stored.summary.droppedCount).some((m, i) => JSON.stringify(m) !== JSON.stringify(session.messages[i]))
  )
  if (summaryInvalidated && !lines.some((line) => line.t === 'clear')) {
    lines.push({ t: 'summary', ts, droppedCount: 0, text: '' })
  }
  if (lines.length === 0) return { ok: true, revision }
  try {
    await appendTransaction(sessionFile(session.projectId, session.id), revision + 1, lines)
  } catch (first) {
    // Retrying the same revision is idempotent, even if the previous append completed.
    await new Promise((resolve) => setTimeout(resolve, 300))
    try { await appendTransaction(sessionFile(session.projectId, session.id), revision + 1, lines) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  if (summaryInvalidated || session.messages.length === 0) invalidateCompactCache(session.id)
  return { ok: true, revision: revision + 1 }
}

export function saveSessionInternal(session: Session): Promise<SessionSaveResult> {
  // Capture caller-owned values before entering the queue; callers may continue editing.
  const snapshot = structuredClone(session)
  return serializeSession(snapshot.projectId, snapshot.id, () => saveSessionUnlocked(snapshot))
}

/** 注册消息编辑 / 删除处理器（上下文管理窗口用） */
function registerSaveAndEditHandlers(): void {
  ipcMain.handle('sessions:save', async (_e, session: Session): Promise<SessionSaveResult> => {
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
      if (r.ok) emitSessionsChanged(projectId, sessionId, { revision: r.revision, change: 'messages' })
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
      if (r.ok) emitSessionsChanged(projectId, sessionId, { revision: r.revision, change: 'messages' })
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
      if (r.ok) emitSessionsChanged(projectId, sessionId, { revision: r.revision, change: 'messages' })
      return r.ok
    },
  )
}
