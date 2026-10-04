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
  /** 可选 HTTP 代理，例如 http://127.0.0.1:7890；留空 = 直连 */
  proxyURL: string
  /** 模型单价：输入（美元 / 每百万 tokens），用于估算花费；不填只记 token 不算钱 */
  priceInputUSD?: number
  /** 模型单价：输出（美元 / 每百万 tokens） */
  priceOutputUSD?: number
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

// ---------- API 调试面板（学习用） ----------

/** 调试列表条目（轻量，不含大字段） */
export interface DebugListItem {
  id: string
  kind: 'chat' | 'test'
  startedAt: number
  durationMs: number | null
  provider: string
  model: string
  url: string
  status: number | null
  error: string | null
  /** 收到的 SSE 事件条数 */
  eventCount: number
  inputTokens: number | null
  outputTokens: number | null
  /** 费用（美元）：provider 报告或按价格估算，null = 未能计费 */
  costUSD: number | null
  costSource: 'provider' | 'estimated' | null
}

/** 调试详情：原始请求/响应内容（密钥已脱敏） */
export interface DebugDetail extends DebugListItem {
  method: string
  /** 本次调用经过的代理地址；null = 直连 */
  proxyURL: string | null
  requestHeaders: Record<string, string>
  /** 请求体（pretty JSON 字符串） */
  requestBody: string
  /** 逐条原始 SSE data 行（不含 "data: " 前缀，最后的 [DONE] 也记录） */
  sseEvents: string[]
  /** 从流中拼装出的最终文本 */
  assembledText: string
  /** 响应中出现的 usage（token 用量），无则 null */
  usage: unknown
  /** 非流式请求（测试连接）的原始响应体 */
  responseBody: string | null
}
