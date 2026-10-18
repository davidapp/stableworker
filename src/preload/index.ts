import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  ApprovalMode,
  ChatEvent,
  ChatRequest,
  ConfigView,
  DebugDetail,
  DebugListItem,
  LLMConfig,
  LLMProfileView,
  LLMTestPayload,
  MCPServerConfig,
  McpResourceContent,
  McpResourceMeta,
  McpServerStatus,
  ModelPricing,
  OfficeFile,
  OfficePreviewResult,
  ProjectInfo,
  PermissionRules,
  Session,
  SessionChangeEvent,
  TaskMode,
  SessionLoadResult,
  SessionMeta,
  SessionSaveResult,
  CheckpointRestoreResult,
  ContextInfo,
  ContextOpResult,
  BalanceResult,
  SkillMeta,
  SubagentTypeConfig,
  HookConfig,
  VideoFile,
} from '../shared/types'
import type { SkillFrontmatter } from '../shared/skillFrontmatter'

/**
 * preload：唯一允许同时接触 Electron API 和页面 JS 的地方。
 * 通过 contextBridge 把一组显式、可审计的方法挂到 window.api 上，
 * 渲染进程只能调用这些方法，拿不到 ipcRenderer / Node 本身。
 */

const api = {
  // Managed Office task files; imports are restricted to the native file picker.
  office: {
    workspace: (): Promise<ConfigView> => ipcRenderer.invoke('office:workspace'),
    import: (sessionId: string): Promise<OfficeFile[]> => ipcRenderer.invoke('office:import', sessionId),
    list: (sessionId: string): Promise<OfficeFile[]> => ipcRenderer.invoke('office:list', sessionId),
    open: (sessionId: string, path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('office:open', sessionId, path),
    preview: (sessionId: string, path: string): Promise<OfficePreviewResult> => ipcRenderer.invoke('office:preview', sessionId, path),
  },
  // Managed video task files; imports are restricted to the native file picker.
  video: {
    workspace: (): Promise<ConfigView> => ipcRenderer.invoke('video:workspace'),
    import: (sessionId: string): Promise<VideoFile[]> => ipcRenderer.invoke('video:import', sessionId),
    list: (sessionId: string): Promise<VideoFile[]> => ipcRenderer.invoke('video:files', sessionId),
    open: (sessionId: string, path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('video:open', sessionId, path),
  },
  // Coding-mode context picker: files are chosen inside the project directory only.
  pickContextFiles: (projectId: string): Promise<Array<{ path: string; name: string; size: number }>> =>
    ipcRenderer.invoke('projects:pickContextFiles', projectId),
  // ---- 配置 ----
  getConfig: (): Promise<ConfigView> => ipcRenderer.invoke('config:get'),
  refreshModelContext: (id?: string, force = true): Promise<{ ok: boolean; message: string; config: ConfigView }> =>
    ipcRenderer.invoke('config:refreshModelContext', id, force),
  saveProfile: (profile: LLMConfig & { id?: string; apiKey?: string }): Promise<ConfigView> =>
    ipcRenderer.invoke('config:saveProfile', profile),
  deleteProfile: (id: string): Promise<ConfigView> => ipcRenderer.invoke('config:deleteProfile', id),
  setActiveLlm: (id: LLMProfileView['id']): Promise<ConfigView> => ipcRenderer.invoke('config:setActiveLlm', id),
  /** 启用/停用一个配置档（停用后从聊天框模型选择列表隐藏；停用激活档自动转移激活） */
  setProfileEnabled: (id: string, enabled: boolean): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setProfileEnabled', id, enabled),
  setApprovalMode: (mode: ApprovalMode): Promise<ConfigView> => ipcRenderer.invoke('config:setApprovalMode', mode),
  setThinkingEffort: (effort: string): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setThinkingEffort', effort),
  setSidebarWidth: (width: number): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setSidebarWidth', width),
  /** 侧栏项目节点的展开状态（整体替换持久化） */
  setSidebarExpanded: (map: Record<string, boolean>): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setSidebarExpanded', map),
  /** 自定义子代理类型（整体替换，出现在 task 工具的 subagent_type 枚举里） */
  setSubagentTypes: (list: SubagentTypeConfig[]): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setSubagentTypes', list),
  /** Hooks 生命周期钩子（整体替换） */
  setHooks: (list: HookConfig[]): Promise<ConfigView> => ipcRenderer.invoke('config:setHooks', list),
  // ---- 窗口控制（隐藏标题栏） ----
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('win:minimize'),
  maximizeToggleWindow: (): Promise<void> => ipcRenderer.invoke('win:maximizeToggle'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('win:close'),
  onMaximizeChange: (callback: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on('win:maximized', listener)
    return () => ipcRenderer.removeListener('win:maximized', listener)
  },

  /** 主进程改了配置（如 Plan 工具切换批准模式）时推送最新视图 */
  onConfigUpdated: (callback: (cfg: ConfigView) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, cfg: ConfigView): void => callback(cfg)
    ipcRenderer.on('config:updated', listener)
    return () => ipcRenderer.removeListener('config:updated', listener)
  },

  /** micro 压缩参数（触发比例 / 保留最近轮数） */
  setMicroCompact: (ratio: number, keep: number): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setMicroCompact', ratio, keep),
  /** 界面偏好（语言 / 主题；局部合并，主题同步原生） */
  setPreferences: (patch: { language?: 'zh' | 'en'; theme?: 'dark' | 'light'; officePanelCollapsed?: boolean; filesPanelCollapsed?: boolean }): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setPreferences', patch),
  /** 分层记忆：查看各层（全局 → 父目录 → 项目 → 项目本地）原文 */
  getMemoryLayers: (projectId: string): Promise<{ layers: { label: string; path: string; raw: string | null }[] }> =>
    ipcRenderer.invoke('memory:getLayers', projectId),
  /** 保存一层记忆（kind: global=userData/AGENTS.md, project=项目/AGENTS.md, local=项目/AGENTS.local.md） */
  saveMemoryLayer: (projectId: string, kind: 'global' | 'project' | 'local', content: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('memory:saveLayer', projectId, kind, content),
  /** 工作目录文件树（扁平相对路径列表，忽略 node_modules/.git/二进制） */
  getProjectFiles: (projectId: string): Promise<string[]> => ipcRenderer.invoke('files:tree', projectId),
  /** 在系统资源管理器中打开（rel 省略 = 工作目录本身） */
  openInExplorer: (projectId: string, rel?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('files:openPath', projectId, rel),
  /** @文件引用补全：项目内文本文件按输入片段过滤（≤30 条） */
  completeFiles: (projectId: string, query: string): Promise<string[]> =>
    ipcRenderer.invoke('files:complete', projectId, query),
  /** 读取 @路径 的文件内容（安全解析在项目内；单文件与总预算截断） */
  readMentions: (projectId: string, paths: string[]): Promise<{ path: string; content: string | null; missing: boolean; truncated: boolean }[]> =>
    ipcRenderer.invoke('files:readMentions', projectId, paths),
  setContextLimit: (limit: number): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setContextLimit', limit),
  setToolSwitch: (name: string, enabled: boolean, mode: 'coding' | 'office' | 'video' = 'coding'): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setToolSwitch', name, enabled, mode),
  setPermissionRules: (rules: PermissionRules): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setPermissionRules', rules),
  addPermissionRule: (rule: string): Promise<ConfigView> => ipcRenderer.invoke('config:addPermissionRule', rule),
  listTools: (mode: 'coding' | 'office' | 'video' = 'coding'): Promise<{ name: string; description: string; requiresApproval: boolean; kind: string | undefined }[]> =>
    ipcRenderer.invoke('tools:list', mode),
  savePricing: (pricing: ModelPricing[]): Promise<ConfigView> => ipcRenderer.invoke('config:savePricing', pricing),
  saveHolidays: (holidays: string[]): Promise<ConfigView> => ipcRenderer.invoke('config:saveHolidays', holidays),
  testLlm: (payload?: LLMTestPayload): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('llm:test', payload),
  listModels: (
    payload?: { id?: string; provider?: 'openai-compatible' | 'anthropic'; name?: string; baseURL?: string; model?: string; proxyURL?: string; apiKey?: string },
  ): Promise<{ ok: boolean; models: { id: string; name?: string }[]; error?: string; fallback?: boolean }> =>
    ipcRenderer.invoke('llm:listModels', payload),

  // ---- 项目 ----
  addProject: (): Promise<ConfigView | null> => ipcRenderer.invoke('projects:add'),
  setActiveProject: (id: ProjectInfo['id']): Promise<ConfigView> => ipcRenderer.invoke('projects:setActive', id),
  removeProject: (id: ProjectInfo['id']): Promise<ConfigView> => ipcRenderer.invoke('projects:remove', id),
  /** 重命名项目（仅改显示名，不动磁盘目录） */
  renameProject: (id: ProjectInfo['id'], name: string): Promise<ConfigView> =>
    ipcRenderer.invoke('projects:rename', id, name),

  // ---- 会话 ----
  listSessions: (projectId: string): Promise<SessionMeta[]> => ipcRenderer.invoke('sessions:list', projectId),
  createSession: (projectId: string, title: string, taskMode?: TaskMode): Promise<Session> =>
    ipcRenderer.invoke('sessions:create', projectId, title, taskMode),
  loadSession: (projectId: string, sessionId: string): Promise<SessionLoadResult | null> =>
    ipcRenderer.invoke('sessions:load', projectId, sessionId),
  saveSession: (session: Session): Promise<SessionSaveResult> =>
    ipcRenderer.invoke('sessions:save', session),
  /** 在资源管理器中显示会话文件（损坏恢复引导用） */
  revealSessionFile: (projectId: string, sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('sessions:reveal', projectId, sessionId),
  /** 回滚检查点：把文件恢复到该次工具调用之前的状态 */
  restoreCheckpoint: (projectId: string, sessionId: string, toolUseId: string): Promise<CheckpointRestoreResult | { error: string } | null> =>
    ipcRenderer.invoke('fileHistory:restore', projectId, sessionId, toolUseId),

  // ---- 上下文管理 ----
  getContextInfo: (projectId: string, sessionId: string): Promise<ContextInfo> =>
    ipcRenderer.invoke('context:getInfo', projectId, sessionId),
  saveContextSummary: (projectId: string, sessionId: string, text: string): Promise<ContextOpResult> =>
    ipcRenderer.invoke('context:saveSummary', projectId, sessionId, text),
  deleteContextSummary: (projectId: string, sessionId: string): Promise<ContextOpResult> =>
    ipcRenderer.invoke('context:deleteSummary', projectId, sessionId),
  compactNow: (projectId: string, sessionId: string): Promise<ContextOpResult> =>
    ipcRenderer.invoke('context:compactNow', projectId, sessionId),
  /** 查询当前配置档的 API Key 余额（按服务商自动适配） */
  queryBalance: (): Promise<BalanceResult> => ipcRenderer.invoke('balance:query'),
  /** 会话被外部（上下文管理窗口）修改时触发，主窗口据此从磁盘重载 */
  onSessionsChanged: (
    callback: (e: SessionChangeEvent) => void,
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: SessionChangeEvent): void =>
      callback(payload)
    ipcRenderer.on('sessions:changed', listener)
    return () => ipcRenderer.removeListener('sessions:changed', listener)
  },
  /** 搜索窗口等请求主窗口打开指定会话 */
  onSessionsOpen: (
    callback: (e: { projectId: string; sessionId: string }) => void,
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { projectId: string; sessionId: string }): void =>
      callback(payload)
    ipcRenderer.on('sessions:open', listener)
    return () => ipcRenderer.removeListener('sessions:open', listener)
  },
  deleteSession: (projectId: string, sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('sessions:delete', projectId, sessionId),
  /** 消息级回退：保留 messageId 及之前；restoreFiles 时按检查点把文件恢复到该时点 */
  rewindTo: (
    projectId: string,
    sessionId: string,
    messageId: string,
    restoreFiles: boolean,
  ): Promise<{ ok: boolean; error?: string; removedCount?: number; restoredFiles?: string[] }> =>
    ipcRenderer.invoke('sessions:rewindTo', projectId, sessionId, messageId, restoreFiles),
  /** 会话分叉：复制 messageId 及之前的消息为新会话，原会话不变，返回新会话 id */
  forkSession: (projectId: string, sessionId: string, messageId: string): Promise<{ ok: boolean; error?: string; newSessionId?: string }> =>
    ipcRenderer.invoke('sessions:fork', projectId, sessionId, messageId),
  /** 会话独立模型（写入会话文件；null = 跟随全局激活档） */
  setSessionModel: (projectId: string, sessionId: string, llmId: string | null): Promise<boolean> =>
    ipcRenderer.invoke('sessions:setModel', projectId, sessionId, llmId),
  renameSession: (projectId: string, sessionId: string, title: string): Promise<boolean> =>
    ipcRenderer.invoke('sessions:rename', projectId, sessionId, title),

  // ---- 聊天 ----
  sendChat: (req: ChatRequest): Promise<{ ok: boolean; error?: string; compacted?: number }> =>
    ipcRenderer.invoke('chat:send', req),
  stopChat: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('chat:stop', sessionId),

  /** 回传用户对危险操作的批准决定；ok=false 表示该批准已失效（超时/停止） */
  respondApproval: (approvalId: string, approved: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('approval:respond', approvalId, approved),
  /** 回传用户对 ask_user_question 的回答 */
  respondAskUser: (questionId: string, answer: string): Promise<boolean> =>
    ipcRenderer.invoke('askUser:respond', questionId, answer),

  /** 打开独立的 API 调试悬浮窗口 */
  openInspector: (): Promise<void> => ipcRenderer.invoke('inspector:open'),
  /** 打开独立的上下文管理悬浮窗口 */
  openContextWindow: (): Promise<void> => ipcRenderer.invoke('context:open'),
  /** 打开独立的全局搜索悬浮窗口 */
  openSearchWindow: (): Promise<void> => ipcRenderer.invoke('search:open'),
  /** 上下文管理窗口：最近使用的会话（主窗口激活项目 + 最新一条） */
  getCurrentSession: (): Promise<{ projectId: string; sessionId: string; title: string } | null> =>
    ipcRenderer.invoke('sessions:current'),
  /** 编辑一条历史消息的文本 */
  editMessage: (projectId: string, sessionId: string, messageId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('sessions:editMessage', projectId, sessionId, messageId, text),
  /** 删除一条历史消息 */
  deleteMessage: (projectId: string, sessionId: string, messageId: string): Promise<boolean> =>
    ipcRenderer.invoke('sessions:deleteMessage', projectId, sessionId, messageId),
  /** 按 id 清空某个会话的上下文 */
  clearSessionContextById: (projectId: string, sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('sessions:clearById', projectId, sessionId),

  // ---- 斜杠命令（skills）：scope 'global' = userData/skills，'project' = <项目>/.stableworker/commands（同名项目优先） ----
  listSkills: (): Promise<SkillMeta[]> => ipcRenderer.invoke('skills:list'),
  saveSkill: (name: string, content: string, scope: SkillMeta['scope'] = 'global'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('skills:save', name, content, scope),
  deleteSkill: (name: string, scope: SkillMeta['scope'] = 'global'): Promise<boolean> =>
    ipcRenderer.invoke('skills:delete', name, scope),

  // ---- MCP 服务器 ----
  getMcpAll: (): Promise<{ servers: MCPServerConfig[]; status: McpServerStatus[] }> =>
    ipcRenderer.invoke('mcp:getAll'),
  /** 保存服务器列表并按新配置 diff 连接，返回保存后的实时状态 */
  saveMcpServers: (servers: MCPServerConfig[]): Promise<{ servers: MCPServerConfig[]; status: McpServerStatus[] }> =>
    ipcRenderer.invoke('mcp:saveServers', servers),
  /** 强制重连一台服务器（忽略现有连接），返回全部状态 */
  reconnectMcp: (name: string): Promise<McpServerStatus[]> => ipcRenderer.invoke('mcp:reconnect', name),
  /** 浏览一台已连接服务器的 resources 列表（第一页） */
  listMcpResources: (name: string): Promise<{ ok: boolean; error?: string; resources: McpResourceMeta[] }> =>
    ipcRenderer.invoke('mcp:listResources', name),
  /** 读取一个资源（取文本部分） */
  readMcpResource: (name: string, uri: string): Promise<{ ok: boolean; error?: string; contents: McpResourceContent[] }> =>
    ipcRenderer.invoke('mcp:readResource', name, uri),
  /** 解析 /name args 斜杠命令 → 展开后的 prompt + frontmatter 元数据（未命中 found:false） */
  resolveSkill: (text: string): Promise<{ found: boolean; content?: string; meta?: SkillFrontmatter }> =>
    ipcRenderer.invoke('skills:resolve', text),
  /** 选段压缩：把 [startId..endId] 范围替换为一条摘要消息 */
  compressRange: (projectId: string, sessionId: string, startId: string, endId: string): Promise<ContextOpResult> =>
    ipcRenderer.invoke('sessions:compressRange', projectId, sessionId, startId, endId),
  /** 全局搜索：跨项目扫描会话消息文本 */
  searchAll: (query: string): Promise<{ projectId: string; sessionId: string; sessionTitle: string; role: string; text: string; updatedAt: number }[]> =>
    ipcRenderer.invoke('sessions:search', query),
  /** 导出会话为 Markdown */
  exportMarkdown: (projectId: string, sessionId: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('sessions:exportMarkdown', projectId, sessionId),
  /** 在主窗口打开指定会话 */
  openSessionInMain: (projectId: string, sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('sessions:open', projectId, sessionId),

  /** 订阅批准请求（危险工具执行前触发） */
  onApprovalRequest: (callback: (event: { sessionId: string; toolUseId: string; approvalId: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: { sessionId: string; toolUseId: string; approvalId: string }): void =>
      callback(event)
    ipcRenderer.on('approval:request', listener)
    return () => ipcRenderer.removeListener('approval:request', listener)
  },

  /** 订阅主进程的流式聊天事件，返回取消订阅函数 */
  onChatEvent: (callback: (event: ChatEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: ChatEvent): void => callback(event)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  },

  // ---- API 调试（学习用） ----
  listDebugExchanges: (limit?: number): Promise<DebugListItem[]> => ipcRenderer.invoke('debug:list', limit),
  getDebugExchange: (id: string): Promise<DebugDetail | null> => ipcRenderer.invoke('debug:get', id),
  /** 导出单条记录为格式化 JSON（保存对话框） */
  exportDebug: (id: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('debug:export', id),
  clearDebugLog: (): Promise<boolean> => ipcRenderer.invoke('debug:clear'),
  /** 有新的 API 交换数据时触发（面板据此实时刷新） */
  onDebugUpdated: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('debug:updated', listener)
    return () => ipcRenderer.removeListener('debug:updated', listener)
  },
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
