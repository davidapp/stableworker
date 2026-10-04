/**
 * 主进程与渲染进程共享的类型。
 * 放在独立目录让两端共同 import，保证 IPC 两端的形状永远一致。
 */

export type ProviderType = 'openai-compatible' | 'anthropic'

/** 批准模式：决定危险工具执行前是否需要用户确认 */
export type ApprovalMode = 'confirm' | 'autoEdit' | 'fullAccess'

export type Currency = 'CNY' | 'USD'

/** 金额：amount 是精确的十进制字符串（不做浮点舍入），source 标明金额来源 */
export interface Money {
  currency: Currency
  amount: string
  source: 'provider' | 'estimated'
}

/**
 * 模型价格：单价均为"本币 / 每百万 tokens"。
 * 输入区分缓存命中/未命中，输出与输入都区分高峰/空闲时段（DeepSeek 式计费）；
 * 不分时段的服务商把两档填成一样即可。
 */
export interface ModelPricing {
  model: string
  currency: Currency
  inputCacheHitOffPeak: number
  inputCacheHitPeak: number
  inputCacheMissOffPeak: number
  inputCacheMissPeak: number
  outputOffPeak: number
  outputPeak: number
}

/** 一条 LLM 配置档（多配置档体系；apiKey 永不出主进程，见 LLMProfileView） */
export interface LLMConfig {
  provider: ProviderType
  /** 显示名称，例如 "DeepSeek"、"GLM" */
  name: string
  /** 例如 https://api.deepseek.com/v1（OpenAI 兼容）/ https://api.anthropic.com（Anthropic） */
  baseURL: string
  /** 模型名，例如 deepseek-flash / claude-sonnet-4-5 */
  model: string
  /** 可选 HTTP 代理，例如 http://127.0.0.1:7890；留空 = 直连 */
  proxyURL: string
  /** 思考力度（推理模型）：off = 不传参数走模型默认；low/medium/high 映射到各协议的对应参数 */
  thinkingEffort?: 'off' | 'low' | 'medium' | 'high'
}

/** 渲染进程可见的配置档视图（apiKey 掩码） */
export interface LLMProfileView extends LLMConfig {
  id: string
  hasApiKey: boolean
  apiKeyHint: string
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

/** 消息内容块：对齐 LLM API 的原生形状（text / tool_use），工具结果挂在 tool_use 块上 */
export interface TextBlock {
  type: 'text'
  text: string
}

/** 推理模型的思考内容块：随会话持久化，并按协议要求回传（DeepSeek 强制、Anthropic 需带签名） */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
  /** Anthropic 的思考块签名（signature_delta），回传时必须携带；其他协议无此字段 */
  signature?: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  /** 与 API 的 tool_use id 对应（OpenAI tool_call_id / Anthropic tool_use_id） */
  id: string
  name: string
  input: Record<string, unknown>
  /**
   * pending_approval = 危险操作（如写文件）等待用户批准；
   * running = 已批准执行中；done / error = 执行完成或失败
   */
  status: 'pending_approval' | 'running' | 'done' | 'error'
  /** 批准请求的 id（等待批准时存在，用于回传用户决定） */
  approvalId?: string
  /** 工具执行结果（文本） */
  result?: string
  /** 执行期间的实时输出（如 run_command 的 stdout 流，逐块追加） */
  output?: string
  durationMs?: number
}

export type MessageBlock = TextBlock | ReasoningBlock | ToolUseBlock

export interface ChatMessage {
  id: string
  role: MessageRole
  blocks: MessageBlock[]
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

/** 功能入口的显示/隐藏状态（配置里没有该条目时默认显示） */
export interface FeatureEntry {
  id: string
  label: string
  hidden: boolean
}

/** 渲染进程可见的配置视图：apiKey 永远不出主进程 */
export interface ConfigView {
  projects: ProjectInfo[]
  activeProjectId: string | null
  /** 所有 LLM 配置档与当前激活项 */
  llmProfiles: LLMProfileView[]
  activeLlmId: string | null
  /** 批准模式 */
  approvalMode: ApprovalMode
  /** 各模型的价格表（全局，按模型名） */
  modelPricing: ModelPricing[]
  /** 中国法定节假日（北京时间 YYYY-MM-DD），用于高峰/空闲判定 */
  holidays: string[]
  /** 功能入口的显隐状态 */
  features: FeatureEntry[]
  /** 侧栏宽度（可拖拽调整，持久化） */
  sidebarWidth: number
  /** 上下文窗口上限（tokens），用于水位条；0 = 未知不显示 */
  contextLimit: number
  /** 工具开关：工具名 → 是否启用；未记录的工具默认启用 */
  toolSwitches: Record<string, boolean>
}

/** 发给 LLM 的历史消息（UI 消息去掉展示字段后的形状） */
export interface ChatHistoryMessage {
  role: MessageRole
  blocks: MessageBlock[]
}

export interface ChatRequest {
  sessionId: string
  /** 激活项目 id，主进程据此解析工具可访问的目录 */
  projectId: string
  messages: ChatHistoryMessage[]
}

/** 测试连接的入参：允许用尚未保存的表单值来测试（id 用于回退到该配置档已存的 key） */
export interface LLMTestPayload extends LLMConfig {
  id?: string
  apiKey?: string
}

/** 主进程 → 渲染进程 的流式聊天事件（含工具调用与批准请求） */
export type ChatEvent =
  | { type: 'delta'; sessionId: string; delta: string }
  | { type: 'reasoning_delta'; sessionId: string; delta: string }
  | { type: 'tool_use'; sessionId: string; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_output'; sessionId: string; toolUseId: string; text: string }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; content: string; isError: boolean }
  | { type: 'approval_request'; sessionId: string; toolUseId: string; approvalId: string }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; sessionId: string; message: string }

// ---------- API 调试面板（学习用） ----------

/** 上下文构成的明细拆分（total 为服务端精确值；system/tools 为本地估算，messages 为余量） */
export interface ContextBreakdown {
  totalTokens: number
  /** 系统提示词（含项目目录说明），估算 */
  systemTokens: number
  /** 工具定义（名称/描述/JSON Schema），估算 */
  toolsTokens: number
  /** 消息部分 = 总量 - 系统 - 工具（聊天历史 + 工具结果），余量推算 */
  messagesTokens: number
  /** 命中缓存的输入 tokens（DeepSeek/OpenAI/Anthropic 均有对应字段） */
  cacheHitTokens: number | null
  /** 缓存命中率 = cacheHit / total */
  cacheHitRate: number | null
}

/** 调试列表条目（轻量，不含大字段） */
export interface DebugListItem {
  id: string
  kind: 'chat' | 'test'
  /** 工具调用回合序号（1 起）；0 = 非对话请求（如测试连接） */
  round: number
  /** 发送前裁剪掉的历史消息条数（0/undefined = 未裁剪） */
  trimmedCount?: number
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
  /** 请求发出时的上下文总输入 tokens（= prompt_tokens，即"这轮历史有多大"） */
  contextTokens: number | null
  /** 上下文构成明细（该轮请求结束后计算） */
  breakdown: ContextBreakdown | null
  /** 本次费用（精确十进制字符串）；null = 未能计费 */
  cost: Money | null
}

/** 调试详情：原始请求/响应内容（密钥已脱敏） */
export interface DebugDetail extends DebugListItem {
  method: string
  /** 本次调用经过的代理地址；null = 直连 */
  proxyURL: string | null
  /** 计费档位：请求发起时刻（北京时间）是否为高峰时段 */
  peak: boolean
  /** 缓存命中/未命中的输入 token 拆分（DeepSeek 等返回） */
  cacheHitTokens: number | null
  cacheMissTokens: number | null
  requestHeaders: Record<string, string>
  /** 请求体（pretty JSON 字符串） */
  requestBody: string
  /** 逐条原始 SSE data 行（不含 "data: " 前缀，最后的 [DONE] 也记录） */
  sseEvents: string[]
  /** 从流中拼装出的最终文本（正文） */
  assembledText: string
  /** 推理模型的思考内容（reasoning_content / thinking），仅供观察 */
  reasoningText: string
  /** 本轮模型发起的工具调用（从响应解析） */
  toolCalls: { id: string; name: string; argsJson: string }[]
  /** 响应中出现的原始 usage 对象，无则 null */
  usage: unknown
  /** 非流式请求（测试连接）的原始响应体 */
  responseBody: string | null
}
