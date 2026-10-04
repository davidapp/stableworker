import { store } from './store'
import type { ChatEvent, ChatMessage, ConfigView, LLMConfig, ModelPricing, Session, SessionMeta } from '../../shared/types'

/**
 * 渲染进程的所有动作收敛在这里，组件只负责展示与调用动作。
 * 动作内部一律从 store.getState() 取最新状态，避免闭包里的旧值。
 */

const uid = (): string =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)

function applyConfig(cfg: ConfigView): void {
  store.setState({
    projects: cfg.projects,
    activeProjectId: cfg.activeProjectId,
    llm: cfg.llm,
    modelPricing: cfg.modelPricing,
    holidays: cfg.holidays,
  })
}

function toMeta(session: Session): SessionMeta {
  return { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }
}

export async function boot(): Promise<void> {
  const cfg = await window.api.getConfig()
  applyConfig(cfg)
  if (cfg.activeProjectId) {
    await reloadSessions(cfg.activeProjectId, { restoreLatest: true })
  }
  store.setState({ booted: true })
}

async function reloadSessions(projectId: string, opts: { restoreLatest?: boolean } = {}): Promise<void> {
  const sessions = await window.api.listSessions(projectId)
  store.setState({ sessions })
  if (opts.restoreLatest && sessions[0]) await selectSession(sessions[0].id)
}

export async function addProject(): Promise<void> {
  const cfg = await window.api.addProject()
  if (!cfg) return // 用户取消了目录选择
  applyConfig(cfg)
  store.setState({ sessions: [], activeSessionId: null, messages: [] })
  if (cfg.activeProjectId) await reloadSessions(cfg.activeProjectId)
}

export async function selectProject(id: string): Promise<void> {
  const cfg = await window.api.setActiveProject(id)
  applyConfig(cfg)
  store.setState({ sessions: [], activeSessionId: null, messages: [] })
  await reloadSessions(id)
}

export async function removeProject(id: string): Promise<void> {
  const cfg = await window.api.removeProject(id)
  applyConfig(cfg)
  store.setState({ sessions: [], activeSessionId: null, messages: [] })
  if (cfg.activeProjectId) await reloadSessions(cfg.activeProjectId)
}

/** 新会话：先不落盘，发出第一条消息时才真正创建，避免空会话文件堆积 */
export function newSession(): void {
  store.setState({ activeSessionId: null, messages: [] })
}

export async function selectSession(id: string): Promise<void> {
  const { activeProjectId } = store.getState()
  if (!activeProjectId) return
  const session = await window.api.loadSession(activeProjectId, id)
  if (!session) {
    store.setState({ activeSessionId: null, messages: [] })
    return
  }
  // 清理上次中断留下的流式标记和空占位消息
  const messages = session.messages
    .filter((m) => !(m.role === 'assistant' && m.streaming && m.content === ''))
    .map((m) => (m.streaming ? { ...m, streaming: false } : m))
  store.setState({ activeSessionId: session.id, messages })
}

export async function deleteSession(id: string): Promise<void> {
  const { activeProjectId, activeSessionId, sessions } = store.getState()
  if (!activeProjectId) return
  await window.api.deleteSession(activeProjectId, id)
  store.setState({
    sessions: sessions.filter((s) => s.id !== id),
    ...(activeSessionId === id ? { activeSessionId: null, messages: [] } : {}),
  })
}

export function openSettings(): void {
  store.setState({ settingsOpen: true })
}

export function closeSettings(): void {
  store.setState({ settingsOpen: false })
}

export function openInspector(): void {
  store.setState({ inspectorOpen: true })
}

export function closeInspector(): void {
  store.setState({ inspectorOpen: false })
}

export async function saveLlm(input: LLMConfig & { apiKey?: string }): Promise<void> {
  const cfg = await window.api.saveLlm(input)
  applyConfig(cfg)
  closeSettings()
}

export async function savePricing(pricing: ModelPricing[]): Promise<void> {
  const cfg = await window.api.savePricing(pricing)
  applyConfig(cfg)
}

/** 把当前会话整体写盘，并同步会话列表的 updatedAt 排序 */
async function persistCurrentSession(): Promise<void> {
  const s = store.getState()
  if (!s.activeProjectId || !s.activeSessionId) return
  const meta = s.sessions.find((m) => m.id === s.activeSessionId)
  if (!meta) return
  const session: Session = {
    id: meta.id,
    projectId: s.activeProjectId,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: Date.now(),
    messages: s.messages,
  }
  await window.api.saveSession(session)
  const newMeta = toMeta(session)
  const sessions = [newMeta, ...s.sessions.filter((m) => m.id !== newMeta.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  )
  store.setState({ sessions })
}

export async function sendChat(text: string): Promise<void> {
  const s = store.getState()
  const content = text.trim()
  if (!content || s.streaming || !s.activeProjectId) return
  if (!s.llm) {
    openSettings() // 没配置 LLM 时直接带用户去设置
    return
  }

  // 无活动会话时先创建（标题取首条消息前 30 字）
  let sessionId = s.activeSessionId
  if (!sessionId) {
    const created = await window.api.createSession(s.activeProjectId, content.slice(0, 30))
    sessionId = created.id
    store.setState((prev) => ({
      activeSessionId: created.id,
      sessions: [toMeta(created), ...prev.sessions],
    }))
  }

  const userMsg: ChatMessage = { id: uid(), role: 'user', content, createdAt: Date.now() }
  const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: Date.now(), streaming: true }
  const messages = [...store.getState().messages, userMsg, assistantMsg]
  store.setState({ messages, streaming: true })
  await persistCurrentSession() // 先把用户消息落盘，防中途崩溃丢失

  // 发给 LLM 的历史：去掉空占位回复与出错回复
  const history = messages
    .filter((m) => !m.error && !(m.streaming && m.content === ''))
    .map((m) => ({ role: m.role, content: m.content }))

  const res = await window.api.sendChat({ sessionId, messages: history })
  // 主进程在流开始前的失败（如未配置）会直接返回 ok:false，这里兜底标注
  if (!res.ok) markStreamingError(res.error ?? '发送失败')
}

export async function stopChat(): Promise<void> {
  const { activeSessionId } = store.getState()
  if (activeSessionId) await window.api.stopChat(activeSessionId)
}

function updateStreamingAssistant(fn: (m: ChatMessage) => ChatMessage): void {
  store.setState((prev) => {
    const reversedIdx = [...prev.messages].reverse().findIndex((m) => m.role === 'assistant' && m.streaming)
    if (reversedIdx === -1) return {}
    const idx = prev.messages.length - 1 - reversedIdx
    const messages = prev.messages.slice()
    messages[idx] = fn(messages[idx])
    return { messages }
  })
}

function markStreamingError(message: string): void {
  updateStreamingAssistant((m) => ({ ...m, streaming: false, error: message }))
  store.setState({ streaming: false })
  void persistCurrentSession()
}

/** 订阅主进程的流式事件（App 挂载时调用一次，返回取消订阅函数） */
export function subscribeChatEvents(): () => void {
  return window.api.onChatEvent((event: ChatEvent) => {
    const s = store.getState()
    if (event.sessionId !== s.activeSessionId) return
    if (event.type === 'delta') {
      updateStreamingAssistant((m) => ({ ...m, content: m.content + event.delta }))
    } else if (event.type === 'done') {
      updateStreamingAssistant((m) => ({ ...m, streaming: false }))
      store.setState({ streaming: false })
      void persistCurrentSession()
    } else {
      markStreamingError(event.message)
    }
  })
}
