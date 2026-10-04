import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  ChatEvent,
  ChatRequest,
  ConfigView,
  DebugDetail,
  DebugListItem,
  LLMConfig,
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
  saveLlm: (llm: LLMConfig & { apiKey?: string }): Promise<ConfigView> => ipcRenderer.invoke('config:saveLlm', llm),
  savePricing: (pricing: ModelPricing[]): Promise<ConfigView> => ipcRenderer.invoke('config:savePricing', pricing),
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
