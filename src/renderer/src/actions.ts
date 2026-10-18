import { store } from './store'
import { setLanguage } from './i18n'
import { sameModelProfile, selectContextExchange } from '../../shared/contextUsage'
import type {
  ApprovalMode,
  ChatEvent,
  ChatHistoryMessage,
  ChatMessage,
  ConfigView,
  LLMConfig,
  MessageBlock,
  ModelPricing,
  ProjectInfo,
  Session,
  SessionMeta,
  Preferences,
  ToolUseBlock,
  TaskMode,
} from '../../shared/types'

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
    llmProfiles: cfg.llmProfiles,
    activeLlmId: cfg.activeLlmId,
    approvalMode: cfg.approvalMode,
    modelPricing: cfg.modelPricing,
    holidays: cfg.holidays,
    sidebarWidth: cfg.sidebarWidth,
    contextLimit: cfg.contextLimit,
    contextInfo: cfg.contextInfo ?? null,
    toolSwitches: cfg.toolSwitches,
    officeToolSwitches: cfg.officeToolSwitches ?? {},
    permissionRules: cfg.permissionRules,
    expandedProjects: cfg.sidebarExpanded ?? {},
    subagentTypes: cfg.subagentTypes ?? [],
    hooks: cfg.hooks ?? [],
    preferences: cfg.preferences ?? { language: 'zh', theme: 'dark' },
  })
  applyPreferences(cfg.preferences ?? { language: 'zh', theme: 'dark' })
}

/** 应用界面偏好：主题切 data-theme；语言切 i18n 模块（组件经 store 变化重渲染） */
function applyPreferences(prefs: Preferences): void {
  // Node 测试环境无 document（session-renderer 等直接调用 applyConfig），跳过 DOM 副作用
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = prefs.theme
  setLanguage(prefs.language)
}

export async function setPreferences(patch: Partial<Preferences>): Promise<void> {
  const merged = { ...store.getState().preferences, ...patch }
  const cfg = await window.api.setPreferences(merged)
  applyConfig(cfg)
}

function toMeta(session: Session): SessionMeta {
  return { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, taskMode: session.taskMode ?? 'coding' }
}

let lastCodingProjectId: string | null = null

/** Office owns a managed workspace; it does not require choosing a code folder. */
export async function switchTaskMode(mode: TaskMode): Promise<void> {
  const before = store.getState()
  if (before.taskMode === mode && (mode === 'coding' || before.activeProjectId === 'office-workspace')) return
  await stopActiveChatForNavigation()
  if (before.taskMode === 'coding') lastCodingProjectId = before.activeProjectId
  let cfg = mode === 'office' ? await window.api.office.workspace() : await window.api.getConfig()
  const projectId = mode === 'office' ? 'office-workspace' : cfg.projects.find((p) => p.id === lastCodingProjectId && p.id !== 'office-workspace')?.id ?? cfg.projects.find((p) => p.id !== 'office-workspace')?.id ?? null
  if (projectId) cfg = await window.api.setActiveProject(projectId)
  applyConfig(cfg)
  store.setState({ taskMode: mode, activeProjectId: projectId, activeSessionId: null, activeSessionRevision: 0, messages: [], sessionWarning: null, saveError: null, compactedNote: null, statusText: null, todos: [] })
  if (projectId) {
    await refreshProjectSessions(projectId)
    const first = store.getState().sessionsByProject[projectId]?.[0]
    if (first) await loadSessionIntoView(projectId, first.id)
  }
}

export async function newOfficeTask(): Promise<void> {
  await stopActiveChatForNavigation()
  await switchTaskMode('office')
  store.setState({ activeSessionId: null, activeSessionRevision: 0, messages: [], sessionWarning: null, saveError: null, compactedNote: null, statusText: null, todos: [] })
  try { await ensureOfficeSession() }
  catch (error) {
    if (store.getState().taskMode === 'office') store.setState({ sessionWarning: error instanceof Error ? error.message : String(error) })
  }
}

let creatingOfficeSession: Promise<string> | null = null
export async function ensureOfficeSession(): Promise<string> {
  if (creatingOfficeSession) return creatingOfficeSession
  const create = async (): Promise<string> => {
    if (store.getState().taskMode !== 'office') await switchTaskMode('office')
    const state = store.getState()
    if (state.activeSessionId) return state.activeSessionId
    const epoch = sessionEditEpoch
    const session = await window.api.createSession('office-workspace', '新办公任务', 'office')
    const current = store.getState()
    if (epoch !== sessionEditEpoch || current.taskMode !== 'office' || current.activeProjectId !== 'office-workspace') {
      throw new Error('创建任务期间已切换工作区，请在当前任务中重新操作')
    }
    store.setState((prev) => ({ activeProjectId: 'office-workspace', activeSessionId: session.id, activeSessionRevision: session.revision ?? 0,
      taskMode: 'office', sessionsByProject: { ...prev.sessionsByProject, 'office-workspace': [toMeta(session), ...(prev.sessionsByProject['office-workspace'] ?? [])] } }))
    return session.id
  }
  creatingOfficeSession = create()
  try { return await creatingOfficeSession } finally { creatingOfficeSession = null }
}

export async function boot(): Promise<void> {
  const cfg = await window.api.getConfig()
  applyConfig(cfg)
  applyPreferences(cfg.preferences)
  store.setState({ taskMode: cfg.activeProjectId === 'office-workspace' ? 'office' : 'coding' })
  const map = await reloadAllSessions(cfg.projects)
  const ap = cfg.activeProjectId
  if (ap) {
    // 展开状态已持久化；从没记录过的项目（首次添加）默认展开
    if (cfg.sidebarExpanded?.[ap] === undefined) {
      store.setState((prev) => ({ expandedProjects: { ...prev.expandedProjects, [ap]: true } }))
    }
    const first = map[ap]?.[0]
    if (first) await loadSessionIntoView(ap, first.id)
  }
  store.setState({ booted: true })
  if (cfg.activeLlmId) void refreshModelContext(cfg.activeLlmId, false)
}

/** 拉取所有项目的会话列表（项目数量少，一次全量刷新最简单） */
async function reloadAllSessions(projects: ProjectInfo[]): Promise<Record<string, SessionMeta[]>> {
  const entries = await Promise.all(
    projects.map(async (p) => [p.id, await window.api.listSessions(p.id)] as const),
  )
  const map = Object.fromEntries(entries)
  store.setState({ sessionsByProject: map })
  return map
}

/** 刷新单个项目的会话列表 */
async function refreshProjectSessions(projectId: string): Promise<void> {
  const sessions = await window.api.listSessions(projectId)
  store.setState((prev) => ({ sessionsByProject: { ...prev.sessionsByProject, [projectId]: sessions } }))
}

/** 把某个会话载入聊天视图（含中断状态清理）；必要时先切换激活项目 */
async function loadSessionIntoView(projectId: string, sessionId: string): Promise<void> {
  const res = await window.api.loadSession(projectId, sessionId)
  if (!res || !res.session) {
    store.setState({ activeSessionId: null, activeSessionRevision: 0, messages: [], sessionWarning: null, compactedNote: null, statusText: null, todos: [] })
    return
  }
  // 清理上次中断留下的流式/运行中状态
  const messages = res.session.messages
    .filter((m) => !(m.role === 'assistant' && m.blocks.length === 0))
    .map((m) => ({
      ...m,
      streaming: false,
      blocks: m.blocks.map((b) =>
        b.type === 'tool_use' && (b.status === 'running' || b.status === 'pending_approval')
          ? { ...b, status: 'error' as const, result: '（会话中断，未获得结果）' }
          : b,
      ),
    }))
  const warning = res.damaged
    ? `⚠ 该会话文件存在损坏：${res.corruptLines}/${res.totalLines} 行无法解析（通常是写入中断或磁盘故障），` +
      `已尽力恢复出 ${messages.length} 条消息。建议尽快导出重要内容；也可以在文件夹中查看原始文件，或删除本会话重建。`
    : null
  store.setState({ activeProjectId: projectId, activeSessionId: res.session.id, activeSessionRevision: res.session.revision ?? 0,
    taskMode: res.session.taskMode ?? 'coding', messages, sessionWarning: warning })
}

export async function addProject(): Promise<void> {
  await stopActiveChatForNavigation()
  const cfg = await window.api.addProject()
  if (!cfg) return // 用户取消了目录选择
  applyConfig(cfg)
  store.setState({ taskMode: 'coding' })
  store.setState({ activeSessionId: null, activeSessionRevision: 0, messages: [], compactedNote: null, statusText: null, todos: [] })
  await reloadAllSessions(cfg.projects)
  if (cfg.activeProjectId) {
    store.setState((prev) => ({ expandedProjects: { ...prev.expandedProjects, [cfg.activeProjectId as string]: true } }))
  }
}

export async function selectProject(id: string): Promise<void> {
  await stopActiveChatForNavigation()
  const cfg = await window.api.setActiveProject(id)
  applyConfig(cfg)
  store.setState({ taskMode: id === 'office-workspace' ? 'office' : 'coding' })
  store.setState({ activeSessionId: null, activeSessionRevision: 0, messages: [], compactedNote: null, statusText: null, todos: [] })
  store.setState((prev) => ({ expandedProjects: { ...prev.expandedProjects, [id]: true } }))
  await refreshProjectSessions(id)
}

/** 展开/折叠项目节点；展开时顺手刷新该项目的会话列表；状态持久化到配置 */
export function toggleProjectExpanded(projectId: string): void {
  const prev = store.getState().expandedProjects
  const next = { ...prev, [projectId]: !prev[projectId] }
  store.setState({ expandedProjects: next })
  void window.api.setSidebarExpanded(next)
  if (next[projectId]) void refreshProjectSessions(projectId)
}

export async function removeProject(id: string): Promise<void> {
  await stopActiveChatForNavigation()
  const cfg = await window.api.removeProject(id)
  applyConfig(cfg)
  store.setState({ activeSessionId: null, activeSessionRevision: 0, messages: [], compactedNote: null, statusText: null, todos: [] })
  store.setState((prev) => {
    const sessionsByProject = { ...prev.sessionsByProject }
    delete sessionsByProject[id]
    const expandedProjects = { ...prev.expandedProjects }
    delete expandedProjects[id]
    return { sessionsByProject, expandedProjects }
  })
}

/** 在指定项目下新建会话：切到该项目并清空视图；真正落盘发生在首条消息发出时 */
export async function newSessionInProject(projectId: string): Promise<void> {
  await stopActiveChatForNavigation()
  if (store.getState().activeProjectId !== projectId) {
    const cfg = await window.api.setActiveProject(projectId)
    applyConfig(cfg)
  }
  store.setState((prev) => ({
    expandedProjects: { ...prev.expandedProjects, [projectId]: true },
    taskMode: projectId === 'office-workspace' ? 'office' : 'coding',
    activeSessionId: null,
    activeSessionRevision: 0,
    messages: [],
    sessionWarning: null,
  }))
}

export async function selectSession(projectId: string, sessionId: string): Promise<void> {
  await stopActiveChatForNavigation()
  if (store.getState().activeProjectId !== projectId) {
    const cfg = await window.api.setActiveProject(projectId)
    applyConfig(cfg)
    store.setState({ activeSessionId: null, activeSessionRevision: 0, messages: [], sessionWarning: null, compactedNote: null, statusText: null, todos: [] })
    store.setState((prev) => ({ expandedProjects: { ...prev.expandedProjects, [projectId]: true } }))
  }
  await loadSessionIntoView(projectId, sessionId)
}

export async function deleteSession(projectId: string, id: string): Promise<void> {
  if (store.getState().activeSessionId === id) await stopActiveChatForNavigation()
  await window.api.deleteSession(projectId, id)
  store.setState((prev) => ({
    sessionsByProject: {
      ...prev.sessionsByProject,
      [projectId]: (prev.sessionsByProject[projectId] ?? []).filter((s) => s.id !== id),
    },
    ...(prev.activeSessionId === id
      ? { activeSessionId: null, activeSessionRevision: 0, messages: [], sessionWarning: null, saveError: null }
      : {}),
  }))
}

/** 重命名会话（只改标题，不改变列表排序） */
export async function renameSession(projectId: string, sessionId: string, title: string): Promise<void> {
  const t = title.trim()
  if (!t) return
  await window.api.renameSession(projectId, sessionId, t)
  store.setState((prev) => ({
    sessionsByProject: {
      ...prev.sessionsByProject,
      [projectId]: (prev.sessionsByProject[projectId] ?? []).map((s) =>
        s.id === sessionId ? { ...s, title: t } : s,
      ),
    },
  }))
}

/** 清空当前会话的上下文（保留会话本身，消息历史清零，下一句从零开始） */
export async function clearSessionContext(): Promise<void> {
  const s = store.getState()
  if (!s.activeSessionId || s.streaming) return
  store.setState({ messages: [] })
  await persistCurrentSession()
}

export function openSettings(page = 'llm'): void {
  store.setState({ settingsOpen: true, settingsPage: page })
}

export function closeSettings(): void {
  store.setState({ settingsOpen: false })
}

export async function saveProfile(profile: LLMConfig & { id?: string; apiKey?: string }): Promise<void> {
  const cfg = await window.api.saveProfile(profile)
  applyConfig(cfg)
  closeSettings()
  const id = profile.id ?? cfg.activeLlmId
  if (id) void refreshModelContext(id, false)
}

export async function deleteProfile(id: string): Promise<void> {
  const cfg = await window.api.deleteProfile(id)
  applyConfig(cfg)
}

/** 启用/停用一个配置档（停用激活档时自动转移激活） */
export async function setProfileEnabled(id: string, enabled: boolean): Promise<void> {
  const cfg = await window.api.setProfileEnabled(id, enabled)
  applyConfig(cfg)
}

export async function setActiveLlm(id: string): Promise<void> {
  const cfg = await window.api.setActiveLlm(id)
  applyConfig(cfg)
  void refreshModelContext(id, false)
}

export async function refreshModelContext(id?: string, force = true): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await window.api.refreshModelContext(id, force)
    // Apply only model metadata; an in-flight refresh must not overwrite project navigation or drafts.
    const current = store.getState()
    const profiles = current.llmProfiles.map((p) => {
      const received = result.config.llmProfiles.find((m) => m.id === p.id && sameModelProfile(p, m))
      return received ? { ...p, contextInfo: received.contextInfo ?? null } : p
    })
    const active = profiles.find((p) => p.id === current.activeLlmId)
    store.setState({ llmProfiles: profiles, contextInfo: active?.contextInfo ?? null, contextLimit: active?.contextInfo?.contextWindow ?? 0 })
    return { ok: result.ok, message: result.message }
  } catch {
    return { ok: false, message: '模型容量刷新失败，保留当前已验证的容量' }
  }
}

export async function setApprovalMode(mode: ApprovalMode): Promise<void> {
  const cfg = await window.api.setApprovalMode(mode)
  applyConfig(cfg)
}

export async function setThinkingEffort(effort: string): Promise<void> {
  const cfg = await window.api.setThinkingEffort(effort)
  applyConfig(cfg)
}

export async function setSidebarWidth(width: number): Promise<void> {
  const cfg = await window.api.setSidebarWidth(width)
  applyConfig(cfg)
}

export async function setToolSwitch(name: string, enabled: boolean, mode: 'coding' | 'office' = 'coding'): Promise<void> {
  const cfg = await window.api.setToolSwitch(name, enabled, mode)
  applyConfig(cfg)
}

export async function setPermissionRules(rules: { allow: string[]; ask: string[]; deny: string[] }): Promise<void> {
  const cfg = await window.api.setPermissionRules(rules)
  applyConfig(cfg)
}

export async function savePricing(pricing: ModelPricing[]): Promise<void> {
  const cfg = await window.api.savePricing(pricing)
  applyConfig(cfg)
}

export async function saveHolidays(holidays: string[]): Promise<void> {
  const cfg = await window.api.saveHolidays(holidays)
  applyConfig(cfg)
}

type ChatResponse = { ok: boolean; error?: string; compacted?: number }
let activeChatRequest: Promise<ChatResponse> | null = null
let chatGeneration = 0
let sessionEditEpoch = 0
const ignoredChatSessions = new Set<string>()
let sessionSaveQueue: Promise<unknown> = Promise.resolve()

async function settleActiveChat(savePartial: boolean): Promise<void> {
  const s = store.getState()
  if (!s.activeSessionId || (!s.streaming && !activeChatRequest)) return
  const id = s.activeSessionId
  chatGeneration++
  ignoredChatSessions.add(id)
  const request = activeChatRequest
  try {
    await window.api.stopChat(id)
    await request?.catch(() => {})
    if (store.getState().activeSessionId !== id) return
    store.setState((prev) => ({ streaming: false, messages: prev.messages.map((m) => m.streaming ? {
      ...m, streaming: false, blocks: m.blocks.map((block) => block.type === 'tool_use' &&
        (block.status === 'running' || block.status === 'pending_approval')
        ? { ...block, status: 'error' as const, result: block.result ?? '（生成已停止）' } : block),
    } : m) }))
    if (savePartial) await persistCurrentSession()
  } finally {
    ignoredChatSessions.delete(id)
  }
}

/** Finish the previous generation before changing a task or navigation mode. */
export async function stopActiveChatForNavigation(): Promise<void> {
  await settleActiveChat(true)
  await sessionSaveQueue.catch(() => {})
  sessionEditEpoch++
}

async function reloadAfterExternalChange(projectId: string, sessionId: string): Promise<void> {
  sessionEditEpoch++
  await settleActiveChat(false)
  const current = store.getState()
  if (current.activeProjectId !== projectId || current.activeSessionId !== sessionId) return
  await loadSessionIntoView(projectId, sessionId)
  await refreshProjectSessions(projectId)
  store.setState({ streaming: false, statusText: '会话已在其他窗口修改，已载入最新版本；此前生成已停止。' })
}

/** Queue renderer saves too, so later snapshots use the revision returned by earlier saves. */
async function persistCurrentSession(): Promise<boolean> {
  const s = store.getState()
  if (!s.activeProjectId || !s.activeSessionId) return false
  const meta = (s.sessionsByProject[s.activeProjectId] ?? []).find((m) => m.id === s.activeSessionId)
  if (!meta) return false
  const epoch = sessionEditEpoch
  const session: Session = {
    id: meta.id, projectId: s.activeProjectId, title: meta.title, createdAt: meta.createdAt,
    updatedAt: Date.now(), messages: structuredClone(s.messages), taskMode: s.taskMode, revision: s.activeSessionRevision,
  }
  const operation = sessionSaveQueue.catch(() => {}).then(async (): Promise<boolean> => {
    if (epoch !== sessionEditEpoch) return false
    const current = store.getState()
    if (current.activeSessionId === session.id && current.activeProjectId === session.projectId) {
      session.revision = current.activeSessionRevision
    }
    const res = await window.api.saveSession(session)
    if (epoch !== sessionEditEpoch) return res.ok
    if (!res.ok) {
      if (res.conflict) await reloadAfterExternalChange(session.projectId, session.id)
      else store.setState({ saveError: res.error ?? '未知写入错误' })
      return false
    }
    const active = store.getState()
    if (active.activeSessionId === session.id && active.activeProjectId === session.projectId) {
      store.setState({ saveError: null, activeSessionRevision: Math.max(active.activeSessionRevision, res.revision ?? session.revision ?? 0) })
    }
    const newMeta = toMeta(session)
    store.setState((prev) => ({ sessionsByProject: { ...prev.sessionsByProject,
      [session.projectId]: [newMeta, ...(prev.sessionsByProject[session.projectId] ?? []).filter((m) => m.id !== session.id)]
        .sort((a, b) => b.updatedAt - a.updatedAt),
    } }))
    return true
  })
  sessionSaveQueue = operation
  return operation
}

/** 保存失败后的手动重试 */
export async function retrySaveSession(): Promise<void> {
  await persistCurrentSession()
}

/** 在资源管理器中显示当前会话文件（损坏恢复引导用） */
export async function revealSessionFile(): Promise<void> {
  const s = store.getState()
  if (s.activeProjectId && s.activeSessionId) {
    await window.api.revealSessionFile(s.activeProjectId, s.activeSessionId)
  }
}

export function dismissSessionWarning(): void {
  store.setState({ sessionWarning: null })
}

/** 回滚检查点：把文件恢复到该次工具调用之前（当前状态会先被快照，可撤销） */
export async function restoreCheckpoint(toolUseId: string): Promise<void> {
  const s = store.getState()
  if (!s.activeProjectId || !s.activeSessionId) return
  const res = await window.api.restoreCheckpoint(s.activeProjectId, s.activeSessionId, toolUseId)
  if (!res) {
    void alert('回滚失败：该次调用没有检查点（可能未启用快照或已被清理）')
    return
  }
  if ('error' in res) {
    void alert(`回滚失败：${res.error}`)
    return
  }
  const note =
    `⏪ 已回滚到本次修改之前：恢复 ${res.restored.length} 个文件` +
    (res.deleted.length ? `，删除 ${res.deleted.length} 个新建文件` : '') +
    `（当前状态已另行快照，可再次回滚撤销本次操作）`
  store.setState((prev) => ({
    messages: prev.messages.map((m) => ({
      ...m,
      blocks: m.blocks.map((b) =>
        b.type === 'tool_use' && b.id === toolUseId
          ? { ...b, rolledBack: true, result: (b.result ? `${b.result}\n` : '') + note }
          : b,
      ),
    })),
  }))
}

export async function sendChat(text: string): Promise<void> {
  const s = store.getState()
  let content = text.trim()
  if (!content || s.streaming || !s.activeProjectId) return
  const generation = ++chatGeneration
  // 斜杠命令的 frontmatter 元数据（allowed-tools / model），随请求传给主进程生效
  let skillMeta: { allowedTools?: string[]; model?: string } | undefined
  // 斜杠命令：/name args → 展开 skills/<name>.md 模板后作为普通消息发送
  if (content.startsWith('/')) {
    const r = await window.api.resolveSkill(content)
    if (r.found && r.content) {
      // 主进程已完成 $参数替换、!`命令` 内嵌执行与 frontmatter 解析
      content = r.content
      if (r.meta?.allowedTools?.length || r.meta?.model) {
        skillMeta = { allowedTools: r.meta.allowedTools, model: r.meta.model }
      }
    }
  }
  // @文件引用：把消息里的 @路径 读取为 [引用文件：…] 分节附加（历史即所见）
  const mentions = [...new Set([...content.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1]))].slice(0, 10)
  if (mentions.length > 0 && s.activeProjectId) {
    const files = await window.api.readMentions(s.activeProjectId, mentions)
    const sections = files
      .filter((f) => mentions.includes(f.path))
      .map((f) =>
        f.missing || f.content == null
          ? `\n\n[引用文件：${f.path}（未找到或不可读）]`
          : `\n\n[引用文件：${f.path}${f.truncated ? '，已截断' : ''}]\n${f.content}`,
      )
    content = content + sections.join('')
  }
  if (!s.activeLlmId) {
    openSettings() // 没有可用配置档时直接带用户去设置
    return
  }
  if (generation !== chatGeneration) return

  // 无活动会话时先创建（标题取首条消息前 30 字）
  let sessionId = s.activeSessionId
  const ap = s.activeProjectId
  if (!sessionId && ap) {
    const created = await window.api.createSession(ap, content.slice(0, 30), s.taskMode)
    if (generation !== chatGeneration) return
    sessionId = created.id
    store.setState((prev) => ({
      activeSessionId: created.id,
      activeSessionRevision: created.revision ?? 0,
      sessionsByProject: {
        ...prev.sessionsByProject,
        [ap]: [toMeta(created), ...(prev.sessionsByProject[ap] ?? [])],
      },
    }))
  }

  if (!sessionId) {
    // ap 非空时上面必然已创建；这里只做类型收窄
    return
  }

  if (s.taskMode === 'office' && s.messages.length === 0) {
    store.setState((prev) => ({ sessionsByProject: { ...prev.sessionsByProject,
      [ap]: (prev.sessionsByProject[ap] ?? []).map((meta) => meta.id === sessionId && meta.title === '新办公任务' ? { ...meta, title: content.slice(0, 30) } : meta) } }))
  }

  const userMsg: ChatMessage = {
    id: uid(),
    role: 'user',
    blocks: [{ type: 'text', text: content }],
    createdAt: Date.now(),
  }
  const assistantMsg: ChatMessage = {
    id: uid(),
    role: 'assistant',
    blocks: [],
    createdAt: Date.now(),
    streaming: true,
  }
  const messages = [...store.getState().messages, userMsg, assistantMsg]
  store.setState({ messages, streaming: true })
  const saved = await persistCurrentSession()
  if (generation !== chatGeneration) return
  if (!saved) {
    store.setState((prev) => ({ streaming: false, messages: prev.messages.map((m) => m.streaming ? { ...m, streaming: false } : m) }))
    return
  }

  // 发给 LLM 的历史：去掉空占位回复；未完成/未批准的工具调用没有结果，不进历史
  const history: ChatHistoryMessage[] = messages
    .filter((m) => !(m.role === 'assistant' && m.blocks.length === 0))
    .map((m) => ({
      role: m.role,
      blocks: m.role === 'assistant'
        ? m.blocks.filter(
            (b) => b.type === 'text' || b.type === 'reasoning' || b.status === 'done' || b.status === 'error',
          )
        : m.blocks,
    }))

  let res: { ok: boolean; error?: string; compacted?: number }
  try {
    const sessionLlmId = s.sessionsByProject[ap]?.find((m) => m.id === sessionId)?.llmId
    const request = window.api.sendChat({ sessionId, projectId: ap, messages: history, revision: store.getState().activeSessionRevision, skill: skillMeta, llmId: sessionLlmId })
    activeChatRequest = request
    try { res = await request } finally { if (activeChatRequest === request) activeChatRequest = null }
  } catch (err) {
    // 主进程异常（如 emit 到已销毁窗口失败）会让 chat:send 整体拒绝——按错误收尾
    res = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (generation !== chatGeneration || store.getState().activeSessionId !== sessionId) return
  // 兜底：主循环已结束，无论 done 事件是否送达，强制收尾流式状态
  if (store.getState().streaming) {
    store.setState((prev) => ({
      streaming: false,
      messages: prev.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    }))
    await persistCurrentSession()
  }
  // 摘要压缩提示：早期对话被折叠为摘要（详见 API 调试面板请求体）
  store.setState({
    compactedNote: res.compacted ? `已折叠早期 ${res.compacted} 条对话为摘要，详情见 API 调试面板` : null,
  })
  // 主进程在流开始前的失败（如未配置）会直接返回 ok:false，这里兜底标注
  if (!res.ok) markStreamingError(res.error ?? '发送失败')
}

export async function stopChat(): Promise<void> {
  await settleActiveChat(true)
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
  updateStreamingAssistant((m) => ({ ...m, streaming: false, error: message,
    blocks: m.blocks.map((b) => b.type === 'tool_use' && (b.status === 'running' || b.status === 'pending_approval')
      ? { ...b, status: 'error' as const, result: b.result ?? `执行已结束：${message}` } : b),
  }))
  store.setState({ streaming: false })
  void persistCurrentSession()
}

/** 文本增量追加到最后一个文本块；若刚执行完工具则另起新文本块 */
function appendTextDelta(blocks: MessageBlock[], delta: string): MessageBlock[] {
  const last = blocks[blocks.length - 1]
  if (last && last.type === 'text') {
    return [...blocks.slice(0, -1), { type: 'text', text: last.text + delta }]
  }
  return [...blocks, { type: 'text', text: delta }]
}

/** 思考增量追加到最后一个思考块（推理模型的 reasoning_content / thinking） */
function appendReasoningDelta(blocks: MessageBlock[], delta: string): MessageBlock[] {
  const last = blocks[blocks.length - 1]
  if (last && last.type === 'reasoning') {
    return [...blocks.slice(0, -1), { type: 'reasoning', text: last.text + delta }]
  }
  return [...blocks, { type: 'reasoning', text: delta }]
}

/** 订阅外部会话修改（上下文管理窗口的编辑/删除/压缩/清空）：
 * 主窗口自动从磁盘重载对应会话与列表，防止旧内存状态覆盖外部修改 */
export function subscribeSessionsChanged(): () => void {
  return window.api.onSessionsChanged(async ({ projectId, sessionId, revision, change }) => {
    const s = store.getState()
    if (s.activeProjectId === projectId && s.activeSessionId === sessionId) {
      if (change === 'summary' && s.streaming) {
        store.setState({ activeSessionRevision: Math.max(s.activeSessionRevision, revision ?? s.activeSessionRevision) })
      } else if (change === 'summary') {
        await loadSessionIntoView(projectId, sessionId)
      } else await reloadAfterExternalChange(projectId, sessionId)
    } else if (s.activeProjectId === projectId) await reloadSessionsOf(projectId)
  })
}

/** 订阅"打开指定会话"请求（全局搜索窗口点击结果 → 主窗口跳转） */
export function subscribeSessionsOpen(): () => void {
  return window.api.onSessionsOpen(async ({ projectId, sessionId }) => {
    await selectSession(projectId, sessionId)
  })
}

async function reloadSessionsOf(projectId: string): Promise<void> {
  const sessions = await window.api.listSessions(projectId)
  store.setState((prev) => ({ sessionsByProject: { ...prev.sessionsByProject, [projectId]: sessions } }))
}

// ---------- 上下文自动压缩（对齐 Claude Code 的 auto-compact） ----------

const AUTO_COMPACT_RATIO = 0.8 // 上下文占用超过上限的 80% 触发
const AUTO_COMPACT_MIN_MESSAGES = 6 // 太短的会话压了没意义
const AUTO_COMPACT_COOLDOWN_MS = 5 * 60_000 // 触发后 5 分钟内不重复
let autoCompactRunning = false
let lastAutoCompactAt = 0

/**
 * 回复完成后检查：上一轮请求的服务端精确 inputTokens 超过水位时，
 * 自动执行与手动"⚡ 压缩全部对话"完全相同的管线（compactNow）。
 * 放在渲染端做是为了零竞态——此时会话刚由 persistCurrentSession 落盘，
 * 压缩完成后 sessions:changed 广播会触发界面从磁盘重载。
 */
async function maybeAutoCompact(): Promise<void> {
  const s = store.getState()
  if (autoCompactRunning || !s.contextLimit) return
  if (Date.now() - lastAutoCompactAt < AUTO_COMPACT_COOLDOWN_MS) return
  if (!s.activeProjectId || !s.activeSessionId) return
  if (s.messages.length < AUTO_COMPACT_MIN_MESSAGES) return
  // compactNow 在主进程读磁盘上的会话文件，先确保本轮回复已落盘
  if (!await persistCurrentSession()) return
  const list = await window.api.listDebugExchanges()
  const latest = selectContextExchange(list, s.activeSessionId, s.llmProfiles.find((p) => p.id === s.activeLlmId))
  const tokens = latest?.inputTokens
  if (!tokens || tokens < s.contextLimit * AUTO_COMPACT_RATIO) return

  autoCompactRunning = true
  lastAutoCompactAt = Date.now()
  const pct = Math.round((tokens / s.contextLimit) * 100)
  store.setState({ statusText: `上下文已达 ${pct}%，自动压缩中…` })
  try {
    const r = await window.api.compactNow(s.activeProjectId, s.activeSessionId)
    if (r.ok) {
      store.setState({ statusText: `✅ 已自动压缩上下文（原 ${pct}%），摘要可在 📚 上下文窗口查看` })
      setTimeout(() => {
        if (store.getState().statusText?.startsWith('✅ 已自动压缩')) store.setState({ statusText: null })
      }, 8000)
    } else {
      store.setState({ statusText: `自动压缩失败：${r.error ?? '未知原因'}（可稍后在上下文窗口手动压缩）` })
    }
  } finally {
    autoCompactRunning = false
  }
}

/** 消息级回退：删除 messageId 之后的所有消息；范围内有文件修改时询问是否一并恢复文件 */
export async function rewindToMessage(messageId: string): Promise<void> {
  const s = store.getState()
  if (!s.activeProjectId || !s.activeSessionId || s.streaming) return
  const idx = s.messages.findIndex((m) => m.id === messageId)
  if (idx < 0 || idx >= s.messages.length - 1) return
  const removedCount = s.messages.length - idx - 1
  if (!(await confirm(`回退到这里？其后 ${removedCount} 条消息将被删除（会话文件即时落盘）。`))) return
  const removed = s.messages.slice(idx + 1)
  const hasFileEdits = removed.some((m) =>
    m.blocks.some((b) => b.type === 'tool_use' && ['write_file', 'edit_file', 'multi_edit'].includes(b.name)),
  )
  let restoreFiles = false
  if (hasFileEdits) {
    restoreFiles = await confirm(
      '该范围内有文件修改。是否同时把文件恢复到该时点？\n（当前文件状态会先被快照，回退后可再撤销）',
    )
  }
  const r = await window.api.rewindTo(s.activeProjectId, s.activeSessionId, messageId, restoreFiles)
  if (!r.ok) {
    store.setState({ statusText: `回退失败：${r.error ?? '未知原因'}` })
    return
  }
  await loadSessionIntoView(s.activeProjectId, s.activeSessionId)
  store.setState({
    statusText: `✅ 已回退（删除 ${r.removedCount ?? 0} 条${r.restoredFiles?.length ? `，恢复 ${r.restoredFiles.length} 个文件` : ''}）`,
  })
  setTimeout(() => {
    if (store.getState().statusText?.startsWith('✅ 已回退')) store.setState({ statusText: null })
  }, 8000)
}

/** 会话分叉：从某条消息复制出新会话并切换过去，原会话保持不变 */
export async function forkFromMessage(messageId: string): Promise<void> {
  const s = store.getState()
  if (!s.activeProjectId || !s.activeSessionId) return
  if (s.messages.findIndex((m) => m.id === messageId) < 0) return
  if (!(await confirm('从此处分叉一个新会话？当前会话保持不变，新会话包含这条消息及之前的全部内容。'))) return
  const r = await window.api.forkSession(s.activeProjectId, s.activeSessionId, messageId)
  if (!r.ok || !r.newSessionId) {
    store.setState({ statusText: `分叉失败：${r.error ?? '未知原因'}` })
    return
  }
  await refreshProjectSessions(s.activeProjectId)
  await selectSession(s.activeProjectId, r.newSessionId)
  store.setState({ statusText: '✅ 已分叉新会话（原会话未改动）' })
  setTimeout(() => {
    if (store.getState().statusText?.startsWith('✅ 已分叉')) store.setState({ statusText: null })
  }, 8000)
}

/** 应用皮肤确认框（替代原生 window.confirm）；danger = 确定按钮红色警示 */
export function confirm(message: string, opts: { danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    store.setState({ confirmState: { message, tone: opts.danger ? 'danger' : 'normal', resolve } })
  })
}

/** 应用皮肤信息框（替代原生 window.alert，单个确定按钮） */
export function alert(message: string): Promise<void> {
  return new Promise((resolve) => {
    store.setState({ confirmState: { message, tone: 'info', resolve: () => resolve(undefined) } })
  })
}

/** ConfirmDialog 按钮回传 */
export function resolveConfirm(v: boolean): void {
  const state = store.getState().confirmState
  state?.resolve(v)
  store.setState({ confirmState: null })
}

/** 会话独立模型：写入会话并刷新视图（菜单勾选与圆环用量跟随该模型） */
export async function setSessionModel(llmId: string): Promise<void> {
  const s = store.getState()
  if (!s.activeProjectId || !s.activeSessionId) return
  const ok = await window.api.setSessionModel(s.activeProjectId, s.activeSessionId, llmId)
  if (ok) {
    await refreshProjectSessions(s.activeProjectId)
    store.setState({ statusText: '✅ 本会话已切换模型（仅此会话生效）' })
    setTimeout(() => {
      if (store.getState().statusText?.startsWith('✅ 本会话')) store.setState({ statusText: null })
    }, 8000)
  }
}

/** 订阅主进程的配置变更推送（Plan 工具切换批准模式后同步界面菜单） */
export function subscribeConfigUpdates(): void {
  window.api.onConfigUpdated((cfg) => applyConfig(cfg))
}

/** 订阅主进程的流式事件（App 挂载时调用一次，返回取消订阅函数） */
export function subscribeChatEvents(): () => void {
  return window.api.onChatEvent((event: ChatEvent) => {
    const s = store.getState()
    if (event.sessionId !== s.activeSessionId || ignoredChatSessions.has(event.sessionId)) return
    if (event.type === 'delta') {
      store.setState({ statusText: null })
      updateStreamingAssistant((m) => ({ ...m, blocks: appendTextDelta(m.blocks, event.delta) }))
    } else if (event.type === 'reasoning_delta') {
      store.setState({ statusText: null })
      updateStreamingAssistant((m) => ({ ...m, blocks: appendReasoningDelta(m.blocks, event.delta) }))
    } else if (event.type === 'status') {
      // 主进程阶段性状态（如"正在压缩早期对话…"）
      store.setState({ statusText: event.text })
    } else if (event.type === 'todos') {
      // 任务清单更新（todo_write 工具）
      store.setState({ todos: event.todos })
    } else if (event.type === 'retry') {
      // 重试会重新生成整段回复：清掉已收到的半截内容，显示重试进度
      store.setState({
        messages: s.messages.map((m) => (m.streaming ? { ...m, blocks: [] } : m)),
        statusText: `请求失败（${event.reason.slice(0, 80)}），第 ${event.attempt}/${event.maxRetries} 次重试，${Math.ceil(event.waitMs / 1000)}s 后重试…`,
      })
    } else if (event.type === 'tool_use') {
      const block: ToolUseBlock = {
        type: 'tool_use',
        id: event.toolUseId,
        name: event.name,
        input: event.input,
        status: 'running',
      }
      updateStreamingAssistant((m) => ({ ...m, blocks: [...m.blocks, block] }))
    } else if (event.type === 'tool_output') {
      // 命令执行中的实时 stdout：追加到对应工具卡片的 output 字段
      updateStreamingAssistant((m) => ({
        ...m,
        blocks: m.blocks.map((b) =>
          b.type === 'tool_use' && b.id === event.toolUseId
            ? { ...b, output: (b.output ?? '') + event.text }
            : b,
        ),
      }))
    } else if (event.type === 'tool_result') {
      updateStreamingAssistant((m) => ({
        ...m,
        blocks: m.blocks.map((b) =>
          b.type === 'tool_use' && b.id === event.toolUseId
            ? { ...b, status: event.isError ? 'error' : 'done', result: event.content }
            : b,
        ),
      }))
    } else if (event.type === 'approval_request') {
      // 危险工具执行前：把对应工具卡片切到"等待批准"状态
      updateStreamingAssistant((m) => ({
        ...m,
        blocks: m.blocks.map((b) =>
          b.type === 'tool_use' && b.id === event.toolUseId
            ? {
                ...b,
                status: 'pending_approval' as const,
                approvalId: event.approvalId,
                approvalSuggest: event.suggestRule,
              }
            : b,
        ),
      }))
    } else if (event.type === 'ask_user') {
      // ask_user_question 工具：把问题卡片挂到对应工具块上，等待用户作答
      updateStreamingAssistant((m) => ({
        ...m,
        blocks: m.blocks.map((b) =>
          b.type === 'tool_use' && b.id === event.toolUseId
            ? {
                ...b,
                userQuestion: { id: event.questionId, question: event.question, options: event.options },
              }
            : b,
        ),
      }))
    } else if (event.type === 'done') {
      updateStreamingAssistant((m) => ({ ...m, streaming: false }))
      store.setState({ streaming: false, statusText: null })
      void persistCurrentSession()
      void maybeAutoCompact()
    } else if (event.type === 'error') {
      store.setState({ statusText: null })
      markStreamingError(event.message)
    }
  })
}
