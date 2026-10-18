import { canSymlink } from './helpers'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ContextOpResult, Session, SessionChangeEvent, SessionSaveResult } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  events: [] as SessionChangeEvent[],
  summarize: vi.fn(),
  cache: new Map<string, { droppedCount: number; summaryText: string }>(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.root },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {
    send: (channel: string, event: SessionChangeEvent) => { if (channel === 'sessions:changed') fixture.events.push(event) },
  } }] },
  dialog: {}, shell: {},
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => fixture.handlers.set(name, handler) },
}))
vi.mock('../src/main/fileHistory', () => ({ deleteSessionCheckpoints: async () => {}, deleteProjectCheckpoints: async () => {} }))
vi.mock('../src/main/compact', () => ({
  setCachedCompact: (id: string, droppedCount: number, summaryText: string) => fixture.cache.set(id, { droppedCount, summaryText }),
  invalidateCompactCache: (id: string) => fixture.cache.delete(id),
  summarizeWithModel: fixture.summarize,
}))
vi.mock('../src/main/config', () => ({
  loadConfig: async () => ({ projects: [], activeLlmId: 'p', llmProfiles: [{ id: 'p', apiKey: 'fixture', name: 'Fixture', provider: 'openai-compatible', model: 'fixture', baseURL: 'https://fixture.example', proxyURL: '' }] }),
  decryptApiKey: () => 'fixture',
}))
vi.mock('../src/main/llm', () => ({ getProxyDispatcher: () => undefined }))
vi.mock('undici', () => ({ fetch: () => { throw new Error('Unexpected real API request') } }))

const message = (id: string, role: 'user' | 'assistant', text: string): ChatMessage => ({ id, role, createdAt: 1, blocks: [{ type: 'text', text }] })
const initialMessages = (): ChatMessage[] => [message('u1', 'user', 'original user'), message('a1', 'assistant', 'original answer'), message('u2', 'user', 'follow up')]
const file = (): string => join(fixture.root, 'sessions', 'project', 'session.jsonl')

async function seed(): Promise<void> {
  await mkdir(join(fixture.root, 'sessions', 'project'), { recursive: true })
  const rows = [{ t: 'meta', ts: 1, title: 'Fixture', createdAt: 1 }, ...initialMessages().map((m, i) => ({ t: 'm', ts: 2, i, m }))]
  await writeFile(file(), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8')
}
async function invoke<T>(name: string, ...args: unknown[]): Promise<T> {
  const handler = fixture.handlers.get(name)
  if (!handler) throw new Error(`Missing handler ${name}`)
  return await handler(undefined, ...args) as T
}
async function loaded(): Promise<Session> {
  const mod = await import('../src/main/sessions')
  const result = await mod.loadSessionAny('project', 'session')
  if (!result.session) throw new Error('Fixture session missing')
  return result.session
}

beforeEach(async () => {
  vi.resetModules()
  fixture.handlers.clear()
  fixture.events.length = 0
  fixture.cache.clear()
  fixture.summarize.mockReset().mockResolvedValue('fixture summary')
  fixture.root = await mkdtemp(join(tmpdir(), 'stableworker-sessions-'))
  await seed()
  const sessions = await import('../src/main/sessions')
  sessions.registerSessionHandlers()
  const context = await import('../src/main/contextManage')
  context.registerContextHandlers()
})
afterEach(async () => { await rm(fixture.root, { recursive: true, force: true }) })

describe('real JSONL session persistence', () => {
  it('persists edits after load instead of comparing an aliased message array', async () => {
    await loaded()
    expect(await invoke<boolean>('sessions:editMessage', 'project', 'session', 'u1', 'edited')).toBe(true)
    expect((await loaded()).messages[0].blocks[0]).toEqual({ type: 'text', text: 'edited' })
    expect((await loaded()).revision).toBe(1)
  })

  it('persists deletion without leaving the old message or stale indexes', async () => {
    expect(await invoke<boolean>('sessions:deleteMessage', 'project', 'session', 'a1')).toBe(true)
    expect((await loaded()).messages.map((m) => m.id)).toEqual(['u1', 'u2'])
  })

  it('persists a compressed range and preserves the remaining messages', async () => {
    const result = await invoke<ContextOpResult>('sessions:compressRange', 'project', 'session', 'u1', 'a1')
    expect(result.ok).toBe(true)
    const session = await loaded()
    expect(session.messages).toHaveLength(2)
    expect(session.messages[0].blocks[0]).toEqual({ type: 'text', text: '[已压缩 2 条对话]\nfixture summary' })
    expect(session.messages[1].id).toBe('u2')
  })

  it('rejects an old renderer snapshot after another window clears the session', async () => {
    const stale = await loaded()
    expect(await invoke<boolean>('sessions:clearById', 'project', 'session')).toBe(true)
    stale.messages.push(message('a2', 'assistant', 'late stream reply'))
    expect(await invoke<SessionSaveResult>('sessions:save', stale)).toMatchObject({ ok: false, conflict: true, revision: 1 })
    expect((await loaded()).messages).toEqual([])
  })

  it('serializes simultaneous saves and accepts only the writer holding the current revision', async () => {
    const a = await loaded()
    const b = structuredClone(a)
    a.messages[0] = message('u1', 'user', 'writer A')
    b.messages[0] = message('u1', 'user', 'writer B')
    const { saveSessionInternal } = await import('../src/main/sessions')
    const results = await Promise.all([saveSessionInternal(a), saveSessionInternal(b)])
    expect(results).toEqual([{ ok: true, revision: 1 }, expect.objectContaining({ ok: false, conflict: true, revision: 1 })])
    expect((await loaded()).messages[0].blocks[0]).toEqual({ type: 'text', text: 'writer A' })
  })

  it('captures caller values before waiting in the write queue', async () => {
    const session = await loaded()
    session.messages[0] = message('u1', 'user', 'captured')
    const { saveSessionInternal } = await import('../src/main/sessions')
    const pending = saveSessionInternal(session)
    session.messages[0] = message('u1', 'user', 'later caller mutation')
    expect((await pending).ok).toBe(true)
    expect((await loaded()).messages[0].blocks[0]).toEqual({ type: 'text', text: 'captured' })
  })

  it('does not recreate a deleted session from an old revision-zero snapshot', async () => {
    const stale = await loaded()
    expect(await invoke<boolean>('sessions:delete', 'project', 'session')).toBe(true)
    expect(await invoke<SessionSaveResult>('sessions:save', stale)).toMatchObject({ ok: false, conflict: true })
    const { loadSessionAny } = await import('../src/main/sessions')
    expect((await loadSessionAny('project', 'session')).session).toBeNull()
  })

  it('rejects a summary computed from history that changed during the model call', async () => {
    let finish!: (summary: string) => void
    fixture.summarize.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
    const pending = invoke<ContextOpResult>('context:compactNow', 'project', 'session')
    await vi.waitFor(() => expect(fixture.summarize).toHaveBeenCalled())
    await invoke('sessions:editMessage', 'project', 'session', 'u1', 'newer history')
    finish('outdated summary')
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('其他窗口') })
    expect((await loaded()).summary).toBeUndefined()
    expect(fixture.cache.has('session')).toBe(false)
  })

  it('versions summary writes and tells an active generation to update its base revision without reloading messages', async () => {
    const { appendSummaryLine } = await import('../src/main/sessions')
    expect(await appendSummaryLine('project', 'session', 2, 'summary', 0)).toEqual({ ok: true, revision: 1 })
    expect(fixture.events.at(-1)).toMatchObject({ sessionId: 'session', change: 'summary', revision: 1 })
    const session = await loaded()
    session.messages.push(message('a2', 'assistant', 'reply'))
    expect(await invoke<SessionSaveResult>('sessions:save', session)).toEqual({ ok: true, revision: 2 })
    expect((await loaded()).summary?.text).toBe('summary')
  })

  it('invalidates a persisted summary when its covered prefix is edited', async () => {
    const { appendSummaryLine } = await import('../src/main/sessions')
    await appendSummaryLine('project', 'session', 2, 'old summary', 0)
    await invoke('sessions:editMessage', 'project', 'session', 'u1', 'edited prefix')
    expect((await loaded()).summary).toBeUndefined()
    expect(fixture.cache.has('session')).toBe(false)
  })

  it('defaults old records to coding and preserves office mode through save, rename, and reload', async () => {
    expect(await loaded()).toMatchObject({ revision: 0, taskMode: 'coding' })
    const office = await invoke<Session>('sessions:create', 'project', 'Office', 'office')
    expect(office).toMatchObject({ taskMode: 'office', revision: 1 })
    office.messages = [message('u', 'user', 'make report')]
    const saved = await invoke<SessionSaveResult>('sessions:save', office)
    expect(saved).toEqual({ ok: true, revision: 2 })
    expect(await invoke<boolean>('sessions:rename', 'project', office.id, 'Report')).toBe(true)
    const { loadSessionAny } = await import('../src/main/sessions')
    expect((await loadSessionAny('project', office.id)).session).toMatchObject({ taskMode: 'office', title: 'Report', revision: 3 })
  })

  it('preserves video mode through create, save, and JSONL replay (回放白名单不得拒收 video)', async () => {
    const video = await invoke<Session>('sessions:create', 'project', 'Video', 'video')
    expect(video).toMatchObject({ taskMode: 'video', revision: 1 })
    video.messages = [message('u', 'user', 'make a short video')]
    expect((await invoke<SessionSaveResult>('sessions:save', video)).ok).toBe(true)
    const { loadSessionAny } = await import('../src/main/sessions')
    expect((await loadSessionAny('project', video.id)).session).toMatchObject({ taskMode: 'video', title: 'Video' })
    const { listSessionMetas } = await import('../src/main/sessions')
    expect((await listSessionMetas('project')).find((m) => m.id === video.id)).toMatchObject({ taskMode: 'video' })
  })

  it('keeps a crash-truncated transaction isolated from the next complete append', async () => {
    const original = await readFile(file(), 'utf-8')
    await writeFile(file(), original + '{"t":"batch","revision":1,', 'utf-8')
    const session = await loaded()
    session.messages[0] = message('u1', 'user', 'after crash')
    expect((await invoke<SessionSaveResult>('sessions:save', session)).ok).toBe(true)
    const { loadSessionAny } = await import('../src/main/sessions')
    const recovered = await loadSessionAny('project', 'session')
    expect(recovered).toMatchObject({ damaged: true, corruptLines: 1 })
    expect(recovered.session?.messages[0].blocks[0]).toEqual({ type: 'text', text: 'after crash' })
  })

  it('deletes an office task together with its managed attachments and generated files', { retry: 1 }, async () => {
    const session = await invoke<Session>('sessions:create', 'office-workspace', 'Office', 'office')
    const { ensureOfficeWorkspace } = await import('../src/main/office')
    const root = await ensureOfficeWorkspace(session.id)
    await writeFile(join(root, 'inputs', 'source.txt'), 'source')
    await writeFile(join(root, 'outputs', 'report.md'), 'report')
    expect(await invoke<boolean>('sessions:delete', 'office-workspace', session.id)).toBe(true)
    await expect(readFile(join(root, 'inputs', 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'outputs', 'report.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    const { loadSessionAny } = await import('../src/main/sessions')
    expect((await loadSessionAny('office-workspace', session.id)).session).toBeNull()
  })

  it('refuses linked office task directories before deleting session records or external files', async (ctx) => {
    if (!(await canSymlink())) { ctx.skip(); return }
    const session = await invoke<Session>('sessions:create', 'office-workspace', 'Office', 'office')
    const { ensureOfficeWorkspace } = await import('../src/main/office')
    const root = await ensureOfficeWorkspace(session.id)
    const outside = join(fixture.root, 'personal-documents')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'keep')
    await rm(root, { recursive: true })
    await symlink(outside, root, 'dir')
    await expect(invoke('sessions:delete', 'office-workspace', session.id)).rejects.toThrow('符号链接')
    expect(await readFile(join(outside, 'keep.txt'), 'utf-8')).toBe('keep')
    const { loadSessionAny } = await import('../src/main/sessions')
    expect((await loadSessionAny('office-workspace', session.id)).session?.id).toBe(session.id)
  })
})
