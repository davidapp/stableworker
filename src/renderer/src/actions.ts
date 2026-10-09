import { store } from './store'
import type {
  ApprovalMode,
  ChatEvent,
  ChatHistoryMessage,
  ChatMessage,
  ConfigView,
  FeatureEntry,
  LLMConfig,
  MessageBlock,
  ModelPricing,
  ProjectInfo,
  Session,
  SessionMeta,
  ToolUseBlock,
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
    features: cfg.features,
    sidebarWidth: cfg.sidebarWidth,
    contextLimit: cfg.contextLimit,
    toolSwitches: cfg.toolSwitches,
    permissionRules: cfg.permissionRules,
  })
}

function toMeta(session: Session): SessionMeta {
  return { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }
}

export async function boot(): Promise<void> {
  const cfg = await window.api.getConfig()
  applyConfig(cfg)
  const map = await reloadAllSessions(cfg.projects)
  const ap = cfg.activeProjectId
  if (ap) {
    store.setState((prev) => ({ expandedProjects: { ...prev.expandedProjects, [ap]: true } }))
    const first = map[ap]?.[0]
    if (first) await loadSessionIntoView(ap, first.id)
  }
  store.setState({ booted: true })
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
    store.setState({ activeSessionId: null, messages: [], sessionWarning: null, compactedNote: null, statusText: null })
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
  store.setState({ activeProjectId: projectId, activeSessionId: res.session.id, messages, sessionWarning: warning })
}

export async function addProject(): Promise<void> {
  const cfg = await window.api.addProject()
  if (!cfg) return // 用户取消了目录选择
  applyConfig(cfg)
  store.setState({ activeSessionId: null, messages: [], compactedNote: null, statusText: null })
  await reloadAllSessions(cfg.projects)
  if (cfg.activeProjectId) {
    store.setState((prev) => ({ expandedProjects: { ...prev.expandedProjects, [cfg.activeProjectId as string]: true } }))
  }
}

export async function selectProject(id: string): Promise<void> {
  const cfg = await window.api.setActiveProject(id)
  applyConfig(cfg)
  store.setState({ activeSessionId: null, messages: [], compactedNote: null, statusText: null })
  store.setState((prev) => ({ expandedProjects: { ...prev.expandedProjects, [id]: true } }))
  await refreshProjectSessions(id)
}

/** 展开/折叠项目节点；展开时顺手刷新该项目的会话列表 */
export function toggleProjectExpanded(projectId: string): void {
  const prev = store.getState().expandedProjects
  const next = { ...prev, [projectId]: !prev[projectId] }
  store.setState({ expandedProjects: next })
  if (next[projectId]) void refreshProjectSessions(projectId)
}

export async function removeProject(id: string): Promise<void> {
  const cfg = await window.api.removeProject(id)
  applyConfig(cfg)
  store.setState({ activeSessionId: null, messages: [], compactedNote: null, statusText: null })
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
  if (store.getState().activeProjectId !== projectId) {
    const cfg = await window.api.setActiveProject(projectId)
    applyConfig(cfg)
  }
  store.setState((prev) => ({
    expandedProjects: { ...prev.expandedProjects, [projectId]: true },
    activeSessionId: null,
    messages: [],
    sessionWarning: null,
  }))
}

export async function selectSession(projectId: string, sessionId: string): Promise<void> {
  if (store.getState().activeProjectId !== projectId) {
    const cfg = await window.api.setActiveProject(projectId)
    applyConfig(cfg)
    store.setState({ activeSessionId: null, messages: [], sessionWarning: null, compactedNote: null, statusText: null })
    store.setState((prev) => ({ expandedProjects: { ...prev.expandedProjects, [projectId]: true } }))
  }
  await loadSessionIntoView(projectId, sessionId)
}

export async function deleteSession(projectId: string, id: string): Promise<void> {
  await window.api.deleteSession(projectId, id)
  store.setState((prev) => ({
    sessionsByProject: {
      ...prev.sessionsByProject,
      [projectId]: (prev.sessionsByProject[projectId] ?? []).filter((s) => s.id !== id),
    },
    ...(prev.activeSessionId === id
      ? { activeSessionId: null, messages: [], sessionWarning: null, saveError: null }
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
}

export async function deleteProfile(id: string): Promise<void> {
  const cfg = await window.api.deleteProfile(id)
  applyConfig(cfg)
}

export async function setActiveLlm(id: string): Promise<void> {
  const cfg = await window.api.setActiveLlm(id)
  applyConfig(cfg)
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

export async function setToolSwitch(name: string, enabled: boolean): Promise<void> {
  const cfg = await window.api.setToolSwitch(name, enabled)
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

export async function saveFeatures(features: FeatureEntry[]): Promise<void> {
  const cfg = await window.api.saveFeatures(features)
  applyConfig(cfg)
}

/** 把当前会话整体写盘，并同步会话列表的 updatedAt 排序 */
async function persistCurrentSession(): Promise<void> {
  const s = store.getState()
  if (!s.activeProjectId || !s.activeSessionId) return
  const meta = (s.sessionsByProject[s.activeProjectId] ?? []).find((m) => m.id === s.activeSessionId)
  if (!meta) return
  const session: Session = {
    id: meta.id,
    projectId: s.activeProjectId,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: Date.now(),
    messages: s.messages,
  }
  const res = await window.api.saveSession(session)
  if (!res.ok) {
    // 写盘失败：新消息只存在内存里，界面持续告警直到保存成功
    store.setState({ saveError: res.error ?? '未知写入错误' })
    return
  }
  store.setState({ saveError: null })
  const newMeta = toMeta(session)
  const ap = s.activeProjectId
  store.setState((prev) => {
    const list = prev.sessionsByProject[ap] ?? []
    const updated = [newMeta, ...list.filter((m) => m.id !== newMeta.id)].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    )
    return { sessionsByProject: { ...prev.sessionsByProject, [ap]: updated } }
  })
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
    window.alert('回滚失败：该次调用没有检查点（可能未启用快照或已被清理）')
    return
  }
  if ('error' in res) {
    window.alert(`回滚失败：${res.error}`)
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
  const content = text.trim()
  if (!content || s.streaming || !s.activeProjectId) return
  if (!s.activeLlmId) {
    openSettings() // 没有可用配置档时直接带用户去设置
    return
  }

  // 无活动会话时先创建（标题取首条消息前 30 字）
  let sessionId = s.activeSessionId
  const ap = s.activeProjectId
  if (!sessionId && ap) {
    const created = await window.api.createSession(ap, content.slice(0, 30))
    sessionId = created.id
    store.setState((prev) => ({
      activeSessionId: created.id,
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
  await persistCurrentSession() // 先把用户消息落盘，防中途崩溃丢失

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
    res = await window.api.sendChat({ sessionId, projectId: ap, messages: history })
  } catch (err) {
    // 主进程异常（如 emit 到已销毁窗口失败）会让 chat:send 整体拒绝——按错误收尾
    res = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
  return window.api.onSessionsChanged(async ({ projectId, sessionId }) => {
    const s = store.getState()
    if (s.streaming) return // 生成中不打断，下次操作前会重载
    const meta = (s.sessionsByProject[projectId] ?? []).find((m) => m.id === sessionId)
    if (meta) await selectSession(projectId, sessionId)
    else if (s.activeProjectId === projectId) await reloadSessionsOf(projectId)
  })
}

async function reloadSessionsOf(projectId: string): Promise<void> {
  const sessions = await window.api.listSessions(projectId)
  store.setState((prev) => ({ sessionsByProject: { ...prev.sessionsByProject, [projectId]: sessions } }))
}

/** 订阅主进程的流式事件（App 挂载时调用一次，返回取消订阅函数） */
export function subscribeChatEvents(): () => void {
  return window.api.onChatEvent((event: ChatEvent) => {
    const s = store.getState()
    if (event.sessionId !== s.activeSessionId) return
    if (event.type === 'delta') {
      store.setState({ statusText: null })
      updateStreamingAssistant((m) => ({ ...m, blocks: appendTextDelta(m.blocks, event.delta) }))
    } else if (event.type === 'reasoning_delta') {
      store.setState({ statusText: null })
      updateStreamingAssistant((m) => ({ ...m, blocks: appendReasoningDelta(m.blocks, event.delta) }))
    } else if (event.type === 'status') {
      // 主进程阶段性状态（如"正在压缩早期对话…"）
      store.setState({ statusText: event.text })
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
    } else if (event.type === 'done') {
      updateStreamingAssistant((m) => ({ ...m, streaming: false }))
      store.setState({ streaming: false, statusText: null })
      void persistCurrentSession()
    } else {
      store.setState({ statusText: null })
      markStreamingError(event.message)
    }
  })
}
