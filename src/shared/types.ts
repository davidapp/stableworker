/**
 * 主进程与渲染进程共享的类型。
 * 放在独立目录让两端共同 import，保证 IPC 两端的形状永远一致。
 */

export type ProviderType = 'openai-compatible' | 'anthropic'

/** LLM 接入配置（apiKey 不会原样发给渲染进程，渲染进程只看得到掩码，见 ConfigView） */
export interface LLMConfig {
  provider: ProviderType
  /** 显示名称，例如 "DeepSeek"、"GLM" */
  name: string
  /** 例如 https://api.deepseek.com/v1（OpenAI 兼容）/ https://api.anthropic.com（Anthropic） */
  baseURL: string
  /** 模型名，例如 deepseek-chat / claude-sonnet-4-5 */
  model: string
}

export interface ProjectInfo {
  id: string
  /** 目录名，仅用于显示 */
  name: string
  /** 规范化绝对路径，作为唯一键（借鉴 Claude Code：按路径为项目建立配置） */
  path: string
  createdAt: number
}

export type MessageRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: number
  /** 该条回复正在流式生成中 */
  streaming?: boolean
  /** 生成失败的错误信息 */
  error?: string
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/** 一个聊天会话（聊天上下文的持久化单位） */
export interface Session extends SessionMeta {
  projectId: string
  messages: ChatMessage[]
}

/** 渲染进程可见的配置视图：apiKey 永远不出主进程 */
export interface ConfigView {
  projects: ProjectInfo[]
  activeProjectId: string | null
  llm: (LLMConfig & { hasApiKey: boolean; apiKeyHint: string }) | null
}

export interface ChatRequest {
  sessionId: string
  messages: { role: MessageRole; content: string }[]
}

/** 测试连接的入参：允许用尚未保存的表单值来测试 */
export interface LLMTestPayload extends LLMConfig {
  apiKey?: string
}

/** 主进程 → 渲染进程 的流式聊天事件 */
export type ChatEvent =
  | { type: 'delta'; sessionId: string; delta: string }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; sessionId: string; message: string }
