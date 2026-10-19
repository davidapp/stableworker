import { useSyncExternalStore } from 'react'
import type {
  ApprovalMode,
  ChatMessage,
  LLMProfileView,
  MediaApiView,
  MediaCapability,
  ModelContextInfo,
  ModelPricing,
  ProjectInfo,
  SessionMeta,
  TaskMode,
  SubagentTypeConfig,
  HookConfig,
  Preferences,
  TodoItem,
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
  activeSessionRevision: number
  taskMode: TaskMode
  /** 当前会话的消息（聊天上下文） */
  messages: ChatMessage[]
  /** 会话文件损坏告警（打开会话时检测到损坏行） */
  sessionWarning: string | null
  /** 会话保存失败的原因（非空 = 有新消息只存在内存里） */
  saveError: string | null
  /** 请求重试状态（流式气泡内显示，如"第 1/4 次重试…"） */
  statusText: string | null
  /** 当前会话的任务清单（todo_write 工具维护，仅当前会话） */
  todos: TodoItem[]
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
  /** 侧栏宽度（拖拽分隔条调整，持久化） */
  sidebarWidth: number
  /** 自定义子代理类型（task 工具 subagent_type 动态枚举） */
  subagentTypes: SubagentTypeConfig[]
  /** Hooks 生命周期钩子 */
  hooks: HookConfig[]
  /** 项目级设置覆盖（projectId → 覆盖项） */
  /** 界面偏好（语言 / 主题） */
  preferences: Preferences
  /** 全局确认对话框状态（actions.confirm 触发，ConfirmDialog 组件渲染） */
  confirmState: { message: string; tone: 'normal' | 'danger' | 'info'; resolve: (v: boolean) => void } | null
  /** 上下文窗口上限（tokens），用于水位条；0 = 未知不显示 */
  contextLimit: number
  contextInfo: ModelContextInfo | null
  /** 工具开关：工具名 → 是否启用；未记录的默认启用（编程模式） */
  toolSwitches: Record<string, boolean>
  /** 办公模式的工具开关（独立于编程模式） */
  officeToolSwitches: Record<string, boolean>
  /** 视频模式的工具开关（独立于编程/办公模式） */
  videoToolSwitches: Record<string, boolean>
  /** 媒体能力 API 配置（apiKey 掩码） */
  mediaApis: Partial<Record<MediaCapability, MediaApiView>>
  /** micro 压缩触发比例（上下文估算超上限的百分比） */
  microCompactRatio: number
  /** micro 压缩保留最近几条助手消息 */
  microCompactKeep: number
  /** 权限规则（deny > ask > allow） */
  permissionRules: { allow: string[]; ask: string[]; deny: string[] }
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
  activeSessionRevision: 0,
  taskMode: 'coding',
  messages: [],
  sessionWarning: null,
  saveError: null,
  statusText: null,
  todos: [],
  compactedNote: null,
  llmProfiles: [],
  activeLlmId: null,
  approvalMode: 'confirm',
  modelPricing: [],
  holidays: [],
  sidebarWidth: 240,
  subagentTypes: [],
  hooks: [],
  preferences: { language: 'zh', theme: 'dark' },
  confirmState: null,
  contextLimit: 0,
  contextInfo: null,
  toolSwitches: {},
  officeToolSwitches: {},
  videoToolSwitches: {},
  mediaApis: {},
  microCompactRatio: 0.55,
  microCompactKeep: 2,
  permissionRules: { allow: [], ask: [], deny: [] },
  settingsPage: 'llm',
  settingsOpen: false,
  streaming: false,
})

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState)
}
