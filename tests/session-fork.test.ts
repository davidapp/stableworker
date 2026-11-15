import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionChangeEvent } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  events: [] as SessionChangeEvent[],
}))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.root },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (c: string, e: SessionChangeEvent) => { if (c === 'sessions:changed') fixture.events.push(e) } } }] },
  dialog: {}, shell: {},
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => fixture.handlers.set(name, handler) },
}))
vi.mock('../src/main/fileHistory', () => ({ deleteSessionCheckpoints: async () => {}, deleteProjectCheckpoints: async () => {}, restoreSnapshot: async () => ({ restored: [], deleted: [] }), sessionCheckpointsRoot: () => 'x' }))
vi.mock('../src/main/compact', () => ({ setCachedCompact: () => {}, invalidateCompactCache: () => {}, summarizeWithModel: vi.fn() }))
vi.mock('../src/main/config', () => ({ loadConfig: async () => ({ projects: [] }) }))
vi.mock('../src/main/llm', () => ({ getProxyDispatcher: () => undefined }))

const message = (id: string, role: 'user' | 'assistant', text: string): ChatMessage => ({ id, role, createdAt: 1, blocks: [{ type: 'text', text }] })

beforeEach(async () => {
  vi.resetModules()
  fixture.handlers.clear()
  fixture.events = []
  fixture.root = await mkdtemp(join(tmpdir(), 'sw-fork-'))
  await mkdir(join(fixture.root, 'sessions', 'project'), { recursive: true })
  const { writeFile } = await import('node:fs/promises')
  const rows = [
    { t: 'meta', ts: 1, title: 'Fixture', createdAt: 1 },
    { t: 'batch', revision: 1, ts: 2, operations: [{ t: 'm', ts: 2, i: 0, m: message('u1', 'user', 'hello') }] },
  ]
  await writeFile(join(fixture.root, 'sessions', 'project', 'session.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
})
afterEach(async () => { await rm(fixture.root, { recursive: true, force: true }) })

describe('fork 全链路', () => {
  it('sessions:fork 落盘成功且文件存在', async () => {
    const mod = await import('../src/main/sessions')
    mod.registerSessionHandlers()
    const r = await (fixture.handlers.get('sessions:fork') as (...a: unknown[]) => Promise<{ ok: boolean; newSessionId?: string; error?: string }>)(undefined, 'project', 'session', 'u1')
    console.log('fork result:', JSON.stringify(r))
    expect(r.ok).toBe(true)
    expect(r.newSessionId).toBeDefined()
    const list = await mod.listSessionMetas('project')
    console.log('metas:', JSON.stringify(list))
    expect(list).toHaveLength(2)
  })
})
