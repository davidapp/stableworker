import { useSyncExternalStore } from 'react'
import type {
  ApprovalMode,
  ChatMessage,
  FeatureEntry,
  LLMProfileView,
  ModelPricing,
  ProjectInfo,
  SessionMeta,
} from '../../shared/types'

/**
 * 极简全局 store：getState / setState / subscribe（约 20 行），
 * 通过 React 的 useSyncExternalStore 接入组件 —— 这个模式借鉴自 Claude Code 的
 * state/store.ts：不依赖 Redux/Zustand，先自己理解原理，等界面复杂了再升级。
 */

export interface AppState {
  booted: boolean
  projects: ProjectInfo[]
  activeProjectId: string | null
  /** 每个项目的会话列表（侧栏树用；key = 项目 id） */
  sessionsByProject: Record<string, SessionMeta[]>
  /** 侧栏里展开的项目（key = 项目 id） */
  expandedProjects: Record<string, boolean>
  activeSessionId: string | null
  /** 当前会话的消息（聊天上下文） */
  messages: ChatMessage[]
  /** 会话文件损坏告警（打开会话时检测到损坏行） */
  sessionWarning: string | null
  /** 会话保存失败的原因（非空 = 有新消息只存在内存里） */
  saveError: string | null
  /** 请求重试状态（流式气泡内显示，如"第 1/4 次重试…"） */
  statusText: string | null
  /** 早期对话已折叠为摘要的提示（会话切换 / 清空上下文时清除） */
  compactedNote: string | null
  llmProfiles: LLMProfileView[]
  activeLlmId: string | null
  /** 批准模式 */
  approvalMode: ApprovalMode
  /** 各模型价格表（全局） */
  modelPricing: ModelPricing[]
  /** 中国法定节假日（北京时间日期） */
  holidays: string[]
  /** 功能入口的显隐状态 */
  features: FeatureEntry[]
  /** 侧栏宽度（拖拽分隔条调整，持久化） */
  sidebarWidth: number
  /** 上下文窗口上限（tokens），用于水位条；0 = 未知不显示 */
  contextLimit: number
  /** 工具开关：工具名 → 是否启用；未记录的默认启用 */
  toolSwitches: Record<string, boolean>
  /** 设置对话框当前页 */
  settingsPage: string
  settingsOpen: boolean
  /** 是否正在流式生成回复 */
  streaming: boolean
}

type Listener = () => void
type Updater<T> = Partial<T> | ((prev: T) => Partial<T>)

function createStore<T extends object>(initial: T) {
  let state = initial
  const listeners = new Set<Listener>()
  return {
    getState: (): T => state,
    setState(update: Updater<T>): void {
      state = { ...state, ...(typeof update === 'function' ? update(state) : update) }
      listeners.forEach((l) => l())
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const store = createStore<AppState>({
  booted: false,
  projects: [],
  activeProjectId: null,
  sessionsByProject: {},
  expandedProjects: {},
  activeSessionId: null,
  messages: [],
  sessionWarning: null,
  saveError: null,
  statusText: null,
  compactedNote: null,
  llmProfiles: [],
  activeLlmId: null,
  approvalMode: 'confirm',
  modelPricing: [],
  holidays: [],
  features: [],
  sidebarWidth: 240,
  contextLimit: 0,
  toolSwitches: {},
  settingsPage: 'llm',
  settingsOpen: false,
  streaming: false,
})

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState)
}
