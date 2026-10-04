import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  ApprovalMode,
  ChatEvent,
  ChatRequest,
  ConfigView,
  DebugDetail,
  DebugListItem,
  FeatureEntry,
  LLMConfig,
  LLMProfileView,
  LLMTestPayload,
  ModelPricing,
  ProjectInfo,
  Session,
  SessionMeta,
} from '../shared/types'

/**
 * preload：唯一允许同时接触 Electron API 和页面 JS 的地方。
 * 通过 contextBridge 把一组显式、可审计的方法挂到 window.api 上，
 * 渲染进程只能调用这些方法，拿不到 ipcRenderer / Node 本身。
 */

const api = {
  // ---- 配置 ----
  getConfig: (): Promise<ConfigView> => ipcRenderer.invoke('config:get'),
  saveProfile: (profile: LLMConfig & { id?: string; apiKey?: string }): Promise<ConfigView> =>
    ipcRenderer.invoke('config:saveProfile', profile),
  deleteProfile: (id: string): Promise<ConfigView> => ipcRenderer.invoke('config:deleteProfile', id),
  setActiveLlm: (id: LLMProfileView['id']): Promise<ConfigView> => ipcRenderer.invoke('config:setActiveLlm', id),
  setApprovalMode: (mode: ApprovalMode): Promise<ConfigView> => ipcRenderer.invoke('config:setApprovalMode', mode),
  setThinkingEffort: (effort: string): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setThinkingEffort', effort),
  setSidebarWidth: (width: number): Promise<ConfigView> =>
    ipcRenderer.invoke('config:setSidebarWidth', width),
  savePricing: (pricing: ModelPricing[]): Promise<ConfigView> => ipcRenderer.invoke('config:savePricing', pricing),
  saveHolidays: (holidays: string[]): Promise<ConfigView> => ipcRenderer.invoke('config:saveHolidays', holidays),
  saveFeatures: (features: FeatureEntry[]): Promise<ConfigView> =>
    ipcRenderer.invoke('config:saveFeatures', features),
  testLlm: (payload?: LLMTestPayload): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('llm:test', payload),

  // ---- 项目 ----
  addProject: (): Promise<ConfigView | null> => ipcRenderer.invoke('projects:add'),
  setActiveProject: (id: ProjectInfo['id']): Promise<ConfigView> => ipcRenderer.invoke('projects:setActive', id),
  removeProject: (id: ProjectInfo['id']): Promise<ConfigView> => ipcRenderer.invoke('projects:remove', id),

  // ---- 会话 ----
  listSessions: (projectId: string): Promise<SessionMeta[]> => ipcRenderer.invoke('sessions:list', projectId),
  createSession: (projectId: string, title: string): Promise<Session> =>
    ipcRenderer.invoke('sessions:create', projectId, title),
  loadSession: (projectId: string, sessionId: string): Promise<Session | null> =>
    ipcRenderer.invoke('sessions:load', projectId, sessionId),
  saveSession: (session: Session): Promise<boolean> => ipcRenderer.invoke('sessions:save', session),
  deleteSession: (projectId: string, sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('sessions:delete', projectId, sessionId),

  // ---- 聊天 ----
  sendChat: (req: ChatRequest): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('chat:send', req),
  stopChat: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('chat:stop', sessionId),

  /** 回传用户对危险操作的批准决定；ok=false 表示该批准已失效（超时/停止） */
  respondApproval: (approvalId: string, approved: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('approval:respond', approvalId, approved),

  /** 打开独立的 API 调试悬浮窗口 */
  openInspector: (): Promise<void> => ipcRenderer.invoke('inspector:open'),

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
  listDebugExchanges: (): Promise<DebugListItem[]> => ipcRenderer.invoke('debug:list'),
  getDebugExchange: (id: string): Promise<DebugDetail | null> => ipcRenderer.invoke('debug:get', id),
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
