# 大模型 API 协议与服务商接入技术规范（v0.9.7）

StableWorker 在底层实现了 **7 种原生大模型通信协议**（[`ProviderType`](../src/shared/types.ts)），并内置了 **39 个国内外主流大模型、算力云网关与本地推理引擎预设**。本文档详细说明各协议的线上报文规范、流式解析、思考流映射、容量探测与余额查询机制。

---

## 1. 七大原生 API 协议对照表

核心实现位于 [`src/main/llm.ts`](../src/main/llm.ts)、[`src/shared/contextUsage.ts`](../src/shared/contextUsage.ts)、[`src/main/compact.ts`](../src/main/compact.ts) 与 [`src/main/debug.ts`](../src/main/debug.ts)。

| 协议标识 (`ProviderType`) | 默认 Base URL | 聊天请求端点 (`chatEndpointForProfile`) | 鉴权请求头 | 流式格式 | 思考力度 (`thinkingEffort`) 映射 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `openai-compatible` | `https://api.deepseek.com` | `{base}/chat/completions` | `Authorization: Bearer {key}` | SSE (`data: {...}` + `[DONE]`) | `reasoning_effort: low \| medium \| high` |
| `openai-responses` | `https://api.openai.com/v1` | `{base}/responses` | `Authorization: Bearer {key}` | SSE (`response.*` 事件流) | `reasoning: { effort, summary: 'auto' }` |
| `anthropic` | `https://api.anthropic.com` | `{base}/v1/messages` | `x-api-key: {key}` + `anthropic-version: 2023-06-01` | SSE (`message_start` ~ `message_stop`) | `thinking: { type: 'enabled', budget_tokens }` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `{base}/models/{model}:streamGenerateContent?alt=sse` | `x-goog-api-key: {key}` | SSE (`candidates[0].content.parts`) | `generationConfig.thinkingConfig: { includeThoughts: true, thinkingBudget }` |
| `azure-openai` | `https://{resource}.openai.azure.com` | `{base}/openai/deployments/{model}/chat/completions?api-version=2025-01-01-preview` | `api-key: {key}` | SSE (`data: {...}` + `[DONE]`) | `reasoning_effort: low \| medium \| high` |
| `ollama` | `http://localhost:11434` | `{base}/api/chat` | 可选 `Authorization: Bearer {key}`（默认免密） | NDJSON（逐行 JSON，`done: true` 结束） | `think: true` |
| `cohere` | `https://api.cohere.com/v2` | `{base}/chat`（自动归一化 `/v2/chat`） | `Authorization: Bearer {key}` | SSE (`content-delta` ~ `message-end`) | `thinking: { type: 'enabled', token_budget }` |

---

## 2. 各协议报文构造与流式解析细节

### 2.1 OpenAI Chat Completions 兼容协议 (`openai-compatible`)
- **适用范围**：DeepSeek、OpenAI、智谱 GLM、通义千问、月之暗面 Kimi、火山方舟、MiniMax、xAI Grok、Mistral、OpenRouter、硅基流动、Groq、vLLM、LM Studio 等绝大多数服务商。
- **思考内容回传**：对于 DeepSeek `deepseek-reasoner` 等模型，含 `tool_calls` 的助手消息必须在同条消息中回传 `reasoning_content`，否则服务端会返回 400 错误；`buildRequest` 会自动拼装 `reasoning_content`。
- **流式解析**：同时兼容 `delta.reasoning_content` 与 `delta.reasoning` 两种思考字段；`delta.tool_calls` 按 `index` 累加 `function.arguments` 分片；主动请求 `stream_options: { include_usage: true }` 获取精确 Token 用量。

### 2.2 OpenAI Responses API (`openai-responses`)
- **适用范围**：OpenAI GPT-5、o3、o4-mini、codex-mini 等新一代原生 Responses 模型。
- **请求结构**：系统提示词放入顶层 `instructions`；历史对话与工具交互序列化为扁平 `input` 数组（用户/助手消息为 `message` 项，工具调用为 `{ type: 'function_call', call_id, name, arguments }`，工具结果为 `{ type: 'function_call_output', call_id, output }`）。
- **流式解析**：监听 `response.output_text.delta`（正文增量）、`response.reasoning_summary_text.delta` / `response.reasoning_text.delta`（思考增量）、`response.output_item.added` 与 `response.function_call_arguments.delta`（工具调用组装），以 `response.completed` 作为流结束信号并从 `response.usage` 提取 Token 用量与缓存命中数。

### 2.3 Anthropic Messages API (`anthropic`)
- **适用范围**：Anthropic Claude 官方 API，以及提供 Anthropic 兼容端点的国产模型（DeepSeek `/anthropic`、智谱 `/api/anthropic`、MiniMax `/anthropic`）。
- **请求结构**：工具定义为 `{ name, description, input_schema }`；带签名的 `thinking` 块原样回传 `{ type: 'thinking', thinking, signature }`；工具结果封装在 `role: 'user'` 消息的 `tool_result` 内容块中。
- **流式解析**：通过 `content_block_start`、`content_block_delta`（支持 `text_delta`、`thinking_delta`、`signature_delta`、`input_json_delta`）、`content_block_stop` 与 `message_stop` 严格校验块闭合状态。

### 2.4 Google Gemini API (`gemini`)
- **适用范围**：Google AI Studio (`generativelanguage.googleapis.com/v1beta`) 的 Gemini 2.5 Pro / Flash / Flash-Lite 等全系模型。
- **工具 Schema 净化（`sanitizeGeminiSchema`）**：Gemini 原生 `functionDeclarations` 不接受 JSON Schema 中的 `$schema` 与 `additionalProperties` 字段，`buildRequest` 在序列化前递归剥离上述字段。
- **请求与流式结构**：角色映射为 `user` 与 `model`；工具调用为 `parts: [{ functionCall: { id, name, args } }]`，工具结果为 `parts: [{ functionResponse: { id, name, response: { result, isError } } }]`。流式块中带 `thought: true` 的 `part.text` 归入思考流，其余归入正文流；用量从 `usageMetadata`（`promptTokenCount`、`candidatesTokenCount`、`thoughtsTokenCount`、`cachedContentTokenCount`）提取。

### 2.5 Azure OpenAI (`azure-openai`)
- **适用范围**：微软 Azure OpenAI Service 企业部署端点。
- **URL 与鉴权**：若 `baseURL` 未显式包含 `/openai/deployments/`，自动按 `{baseURL}/openai/deployments/{encodeURIComponent(model)}/chat/completions?api-version=2025-01-01-preview` 构造请求地址，并使用 `api-key` 请求头鉴权。

### 2.6 Ollama 原生协议 (`ollama`)
- **适用范围**：本地或局域网部署的 Ollama 服务（默认 `http://localhost:11434`）。
- **免密与 NDJSON 流**：通过 `isApiKeyOptional` 识别无需 API Key 即可调用；请求发往 `/api/chat`（工具结果 `role: 'tool'` 携带 `tool_name`）；`readSSE` 自动识别 `{` 开头的 NDJSON 行并逐行派发，支持 `message.thinking`、`message.content`、`message.tool_calls` 及 `prompt_eval_count` / `eval_count` 统计。

### 2.7 Cohere API v2 (`cohere`)
- **适用范围**：Cohere Command A (`command-a-03-2025`)、Command R+ 等模型。
- **流式解析**：解析 Cohere v2 事件流（`content-delta`、`thinking-delta`、`tool-call-start`、`tool-call-delta`、`message-end`），从 `delta.usage.tokens` 提取输入输出 Token。

---

## 3. 本地免密机制与 HTTP 代理

- **本地免密判断（`isApiKeyOptional`）**：当 `provider === 'ollama'`，或 `baseURL` 的主机名为 `localhost`、`127.0.0.1`、`::1`、`[::1]`、`0.0.0.0` 时，允许配置档不填 API Key 直接发起对话、测试连接、拉取模型列表与压缩上下文。
- **HTTP/HTTPS 代理支持（`getProxyDispatcher`）**：每个模型配置档均可独立配置 `proxyURL`（如 `http://127.0.0.1:7890`）。主进程使用 `undici` 的 `ProxyAgent` 按代理地址缓存复用连接池，并统一作用于对话流、摘要压缩、模型列表拉取、上下文容量探测、余额查询及 `web_search`。

---

## 4. 模型上下文容量探测与三级回退（`src/main/modelContexts.ts`）

StableWorker 不使用固定默认值（如 32k）猜测模型容量，而是按以下优先级解析每个配置档的 `contextWindow`（输入窗口）与 `maxOutputTokens`（输出上限）：

1. **手动覆盖（`manual`）**：若用户在 LLM 配置档中显式填写了「手动上下文上限」，优先采用该数值。
2. **服务端实时探测（`service`）**：
   - `openai-compatible` / `openai-responses` / `anthropic` / `cohere`：请求 `{base}/models/{model}` 或 `{base}/models`；
   - `gemini`：请求 `{base}/models/{model}`，解析 `inputTokenLimit` 与 `outputTokenLimit`；
   - `ollama`：POST `{base}/api/show`（`{ model }`），解析 `model_info` 中的 `*.context_length`。
3. **官方核实配置表（`configured`）**：若服务端 `/models` 未返回容量字段，匹配仓库内置的 [`config/model-contexts.json`](../config/model-contexts.json)（已收录 DeepSeek、OpenAI、Anthropic Claude、Google Gemini、智谱 GLM、月之暗面 Kimi、阿里云百炼 Qwen 等官方核实容量与核实日期）。
4. **未确认状态（`unverified`）**：以上均未命中时标记为「上限未确认」，界面如实展示已用 Token 而不伪造百分比。

---

## 5. 模型列表在线拉取与多平台余额查询

### 5.1 模型列表拉取（`llm:listModels`）
- 在配置档编辑界面点击「拉取模型」或在配置档卡片菜单点击「获取模型列表」时，按当前选择的协议请求对应端点（`/models`、`/api/tags` 等）。
- 对于不提供标准 `/models` 列表接口或返回为空的服务商，内置 20+ 家主流平台常用模型回退表（`FALLBACK_MODELS`），保证下拉列表始终可用。

### 5.2 多平台余额查询（`balance:query`）
`src/main/contextManage.ts` 支持对任意配置档查询账户余额（自动走该配置档的 `proxyURL`）：
- **DeepSeek**：`GET {origin}/user/balance`（返回可用总额、赠送余额、充值余额）
- **OpenRouter**：`GET https://openrouter.ai/api/v1/credits`（返回剩余额度、已用额度、总额度 USD）
- **硅基流动（SiliconFlow）**：`GET https://api.siliconflow.cn/v1/user/info`（返回总余额、充值余额、赠送余额 CNY）
- **月之暗面（Moonshot Kimi）**：`GET {base}/users/me/balance`（返回可用余额、现金余额、代金券余额 CNY）

---

## 6. 内置 39 个服务商预设一览

定义于 [`src/renderer/src/components/settings/LlmConfigPage.tsx`](../src/renderer/src/components/settings/LlmConfigPage.tsx)：

- **国内主流大模型（17 个）**：DeepSeek、DeepSeek（Anthropic 兼容）、智谱 GLM（ビッグモデル）、智谱 GLM（Anthropic 兼容）、通义千问（阿里云百炼）、月之暗面 Kimi（Moonshot）、火山方舟（豆包 Doubao）、MiniMax、MiniMax（Anthropic 兼容）、百川智能（Baichuan）、零一万物（Yi / 万知）、阶跃星辰（StepFun）、腾讯混元（Hunyuan）、百度千帆（文心一言 ERNIE）、讯飞星火（Spark）、商汤日日新（SenseNova）、小米 MiMo。
- **海外主流大模型（10 个）**：OpenAI（Chat Completions）、OpenAI（Responses API）、Anthropic Claude、Google Gemini（原生 API）、Google Gemini（OpenAI 兼容）、xAI Grok、Mistral AI、Cohere（原生 v2 API）、Cohere（OpenAI 兼容）、Perplexity（Sonar）、AI21 Labs（Jamba）。
- **聚合网关与算力云（16 个）**：OpenRouter、硅基流动（SiliconFlow）、Groq（极速推理）、Together AI、Fireworks AI、NVIDIA NIM、Cerebras、DeepInfra、Novita AI、PPIO 派欧云、七牛云 AI 大模型、无问芯穹（Infini-AI）、GitHub Models、Cloudflare Workers AI、HuggingFace Router、Azure OpenAI（原生部署）。
- **本地部署与自建网关（6 个）**：Ollama（原生 API）、Ollama（OpenAI 兼容）、LM Studio（本地）、vLLM / SGLang（本地）、llama.cpp Server（本地）、LocalAI（本地）、One API / New API / LiteLLM。
