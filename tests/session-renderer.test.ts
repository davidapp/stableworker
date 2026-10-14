import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, Session, SessionChangeEvent, SessionSaveResult } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  changed: null as ((event: SessionChangeEvent) => unknown) | null,
  chat: null as ((event: ChatEvent) => unknown) | null,
  api: {
    saveSession: vi.fn(), sendChat: vi.fn(), stopChat: vi.fn(), loadSession: vi.fn(),
    listSessions: vi.fn(), setActiveProject: vi.fn(), createSession: vi.fn(), listDebugExchanges: vi.fn(),
    onSessionsChanged: vi.fn(), onChatEvent: vi.fn(), getConfig: vi.fn(),
  },
}))

function authoritative(id = 'session', revision = 8): Session {
  return { id, projectId: 'project', title: id, createdAt: 1, updatedAt: 2, revision, taskMode: 'coding', messages: [] }
}

beforeEach(() => {
  vi.resetModules()
  Object.values(fixture.api).forEach((mock) => mock.mockReset())
  fixture.changed = null
  fixture.chat = null
  fixture.api.onSessionsChanged.mockImplementation((handler) => { fixture.changed = handler; return () => {} })
  fixture.api.onChatEvent.mockImplementation((handler) => { fixture.chat = handler; return () => {} })
  fixture.api.saveSession.mockImplementation(async (session: Session): Promise<SessionSaveResult> => ({ ok: true, revision: (session.revision ?? 0) + 1 }))
  fixture.api.sendChat.mockResolvedValue({ ok: true })
  fixture.api.stopChat.mockResolvedValue(undefined)
  fixture.api.loadSession.mockImplementation(async (_project: string, id: string) => ({ session: authoritative(id), damaged: false, corruptLines: 0, totalLines: 1 }))
  fixture.api.listSessions.mockResolvedValue([{ id: 'session', title: 'session', createdAt: 1, updatedAt: 2 }])
  fixture.api.listDebugExchanges.mockResolvedValue([])
  vi.stubGlobal('window', { api: fixture.api })
})

async function setup() {
  const { store } = await import('../src/renderer/src/store')
  const actions = await import('../src/renderer/src/actions')
  store.setState({
    booted: true, activeProjectId: 'project', activeSessionId: 'session', activeSessionRevision: 0,
    taskMode: 'office', streaming: false, activeLlmId: 'p',
    projects: [{ id: 'project', name: 'Fixture', path: '/fixture', createdAt: 1 }],
    sessionsByProject: { project: [{ id: 'session', title: 'session', createdAt: 1, updatedAt: 2, taskMode: 'office' }] },
    messages: [{ id: 'u1', role: 'user', createdAt: 1, blocks: [{ type: 'text', text: 'existing context' }] }],
  })
  actions.subscribeSessionsChanged()
  actions.subscribeChatEvents()
  return { store, actions }
}

describe('renderer session revision coordination', () => {
  it('restores Office navigation after restart even when all Office tasks were deleted', async () => {
    const { store, actions } = await setup()
    fixture.api.getConfig.mockResolvedValue({ ...store.getState(), activeProjectId: 'office-workspace', activeLlmId: null,
      projects: [{ id: 'office-workspace', name: '办公任务', path: '/fixture/office', createdAt: 1 }], sidebarExpanded: {} })
    fixture.api.listSessions.mockResolvedValue([])
    store.setState({ taskMode: 'coding' })
    await actions.boot()
    expect(store.getState()).toMatchObject({ taskMode: 'office', activeProjectId: 'office-workspace', booted: true })
  })
  it('a late Office create does not steal navigation after the user switches to coding', async () => {
    const { store, actions } = await setup()
    store.setState({ activeProjectId: 'office-workspace', activeSessionId: null })
    let complete!: (value: Session) => void
    fixture.api.createSession.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const creating = actions.ensureOfficeSession()
    const rejected = expect(creating).rejects.toThrow('已切换')
    await vi.waitFor(() => expect(fixture.api.createSession).toHaveBeenCalled())
    await actions.stopActiveChatForNavigation()
    store.setState({ taskMode: 'coding', activeProjectId: 'project', activeSessionId: 'coding-session' })
    complete({ ...authoritative('late-office'), projectId: 'office-workspace', taskMode: 'office' })
    await rejected
    expect(store.getState()).toMatchObject({ taskMode: 'coding', activeProjectId: 'project', activeSessionId: 'coding-session' })
  })
  it('uses the acknowledged revision in the chat request and subsequent saves, retaining task mode', async () => {
    const { store, actions } = await setup()
    await actions.sendChat('next task')
    expect(fixture.api.sendChat.mock.calls[0][0]).toMatchObject({ sessionId: 'session', revision: 1 })
    expect(fixture.api.saveSession.mock.calls[0][0]).toMatchObject({ revision: 0, taskMode: 'office' })
    expect(fixture.api.saveSession.mock.calls[1][0]).toMatchObject({ revision: 1, taskMode: 'office' })
    expect(store.getState()).toMatchObject({ activeSessionRevision: 2, streaming: false })
  })

  it('stops an active generation and reloads an external clear without saving its old in-memory messages', async () => {
    const { store, actions } = await setup()
    let finish!: (response: { ok: boolean }) => void
    fixture.api.sendChat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fixture.api.stopChat.mockImplementationOnce(async () => {
      fixture.chat?.({ type: 'done', sessionId: 'session' })
      finish({ ok: true })
    })
    const sending = actions.sendChat('long running task')
    await vi.waitFor(() => expect(fixture.api.sendChat).toHaveBeenCalled())
    await fixture.changed?.({ projectId: 'project', sessionId: 'session', revision: 8, change: 'messages' })
    await sending
    expect(fixture.api.stopChat).toHaveBeenCalledWith('session')
    expect(fixture.api.saveSession).toHaveBeenCalledTimes(1)
    expect(store.getState()).toMatchObject({ messages: [], activeSessionRevision: 8, streaming: false })
  })

  it('updates a generation revision for internal summary writes without stopping or replacing its messages', async () => {
    const { store, actions } = await setup()
    let finish!: (response: { ok: boolean }) => void
    fixture.api.sendChat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const sending = actions.sendChat('task')
    await vi.waitFor(() => expect(fixture.api.sendChat).toHaveBeenCalled())
    const before = store.getState().messages
    await fixture.changed?.({ projectId: 'project', sessionId: 'session', revision: 2, change: 'summary' })
    expect(store.getState().messages).toBe(before)
    expect(store.getState().activeSessionRevision).toBe(2)
    expect(fixture.api.stopChat).not.toHaveBeenCalled()
    finish({ ok: true })
    await sending
    expect(fixture.api.saveSession.mock.calls[1][0].revision).toBe(2)
    expect(store.getState().activeSessionRevision).toBe(3)
  })

  it('awaits a stopped generation before navigating and excludes its late events from the next task', async () => {
    const { store, actions } = await setup()
    let finish!: (response: { ok: boolean }) => void
    fixture.api.sendChat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fixture.api.stopChat.mockImplementationOnce(async () => { finish({ ok: true }) })
    const sending = actions.sendChat('task')
    await vi.waitFor(() => expect(fixture.api.sendChat).toHaveBeenCalled())
    await actions.selectSession('project', 'next-session')
    await sending
    fixture.chat?.({ type: 'delta', sessionId: 'session', delta: 'late old text' })
    fixture.chat?.({ type: 'done', sessionId: 'session' })
    expect(store.getState()).toMatchObject({ activeSessionId: 'next-session', activeSessionRevision: 8, taskMode: 'coding', messages: [], streaming: false })
    expect(fixture.api.saveSession.mock.calls.every(([saved]) => saved.id === 'session')).toBe(true)
  })

  it('reloads a CAS conflict before sending a model request', async () => {
    const { store, actions } = await setup()
    fixture.api.saveSession.mockResolvedValueOnce({ ok: false, conflict: true, revision: 8, error: 'changed' })
    await actions.sendChat('task')
    expect(fixture.api.sendChat).not.toHaveBeenCalled()
    expect(store.getState()).toMatchObject({ activeSessionRevision: 8, messages: [], streaming: false })
  })

  it('refreshes an inactive session list without navigating away from the active task', async () => {
    const { store } = await setup()
    await fixture.changed?.({ projectId: 'project', sessionId: 'other-session', change: 'messages', revision: 4 })
    expect(fixture.api.listSessions).toHaveBeenCalledWith('project')
    expect(fixture.api.loadSession).not.toHaveBeenCalled()
    expect(store.getState().activeSessionId).toBe('session')
  })
})
