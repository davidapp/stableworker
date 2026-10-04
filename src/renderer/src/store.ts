import { useSyncExternalStore } from 'react'
import type { ChatMessage, ConfigView, ModelPricing, ProjectInfo, SessionMeta } from '../../shared/types'

/**
 * 极简全局 store：getState / setState / subscribe（约 20 行），
 * 通过 React 的 useSyncExternalStore 接入组件 —— 这个模式借鉴自 Claude Code 的
 * state/store.ts：不依赖 Redux/Zustand，先自己理解原理，等界面复杂了再升级。
 */

export interface AppState {
  booted: boolean
  projects: ProjectInfo[]
  activeProjectId: string | null
  /** 当前项目的会话列表 */
  sessions: SessionMeta[]
  activeSessionId: string | null
  /** 当前会话的消息（聊天上下文） */
  messages: ChatMessage[]
  llm: ConfigView['llm']
  /** 各模型价格表（全局） */
  modelPricing: ModelPricing[]
  /** 中国法定节假日（北京时间日期） */
  holidays: string[]
  settingsOpen: boolean
  inspectorOpen: boolean
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
  sessions: [],
  activeSessionId: null,
  messages: [],
  llm: null,
  modelPricing: [],
  holidays: [],
  settingsOpen: false,
  inspectorOpen: false,
  streaming: false,
})

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState)
}
