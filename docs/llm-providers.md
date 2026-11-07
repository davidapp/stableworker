# 大模型 API 协议与服务商接入技术规范（v0.9.7）

StableWorker 在底层实现了 **7 种原生大模型通信协议**（[`ProviderType`](../src/shared/types.ts)），并内置了 **47 个国内外主流大模型、算力云网关与本地推理引擎预设**（外加 1 个自定义项，共 48 项）。本文档详细说明各协议的线上报文规范、流式解析、思考流映射、容量探测与余额查询机制。

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

## 6. 内置 47 个服务商预设一览

定义于 [`src/renderer/src/components/settings/LlmConfigPage.tsx`](../src/renderer/src/components/settings/LlmConfigPage.tsx)：

### 6.1 国内主流大模型（16 项）

| 预设 ID | 名称 | 协议 (`provider`) | 默认 Base URL | 预置常用模型候选 |
| :--- | :--- | :--- | :--- | :--- |
| `deepseek` | DeepSeek（官方 OpenAI 兼容） | `openai-compatible` | `https://api.deepseek.com/` | `deepseek-flash`, `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner` |
| `deepseek-anthropic` | DeepSeek（Anthropic 兼容端点） | `anthropic` | `https://api.deepseek.com/anthropic` | `deepseek-flash`, `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner` |
| `dashscope` | 阿里云百炼 / 通义千问（DashScope） | `openai-compatible` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-max`, `qwen3-coder-plus`, `qwen-max`, `qwen-plus`, `qwen-turbo`, `qwq-plus` |
| `zhipu` | 智谱 GLM（BigModel 官方） | `openai-compatible` | `https://open.bigmodel.cn/api/paas/v4/` | `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `glm-4.7`, `glm-4.6`, `glm-4.5` |
| `zhipu-anthropic` | 智谱 GLM（Anthropic 兼容端点） | `anthropic` | `https://open.bigmodel.cn/api/anthropic` | `glm-5.3`, `glm-5.2`, `glm-4.7`, `glm-4.6`, `glm-4.5` |
| `kimi` | 月之暗面（Moonshot Kimi） | `openai-compatible` | `https://api.moonshot.cn/v1` | `kimi-k2`, `kimi-k2-turbo-preview`, `kimi-latest`, `moonshot-v1-128k` |
| `volcengine` | 字节跳动豆包 / 火山方舟（Volcengine Ark） | `openai-compatible` | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6-250615`, `doubao-seed-1-6-thinking-250615`, `doubao-1-5-pro-256k-250115`, `deepseek-r1-250528` |
| `hunyuan` | 腾讯混元（Hunyuan） | `openai-compatible` | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-t1-latest`, `hunyuan-turbos-latest`, `hunyuan-pro`, `hunyuan-standard` |
| `qianfan` | 百度文心千帆（Qianfan V2） | `openai-compatible` | `https://qianfan.baidubce.com/v2` | `ernie-4.5-turbo-128k`, `ernie-x1-turbo-32k`, `deepseek-r1` |
| `minimax` | MiniMax（海螺 AI） | `openai-compatible` | `https://api.minimax.chat/v1` | `MiniMax-M1`, `MiniMax-Text-01`, `abab6.5s-chat` |
| `stepfun` | 阶跃星辰（StepFun） | `openai-compatible` | `https://api.stepfun.com/v1` | `step-3`, `step-r1-v-mini`, `step-2-16k`, `step-1-256k` |
| `yi` | 零一万物（Yi / Lingyiwanwu） | `openai-compatible` | `https://api.lingyiwanwu.com/v1` | `yi-lightning`, `yi-large`, `yi-medium` |
| `baichuan` | 百川智能（Baichuan） | `openai-compatible` | `https://api.baichuan-ai.com/v1` | `Baichuan4-Turbo`, `Baichuan4-Air`, `Baichuan4` |
| `spark` | 讯飞星火（Spark） | `openai-compatible` | `https://spark-api-open.xf-yun.com/v1` | `x1`, `4.0Ultra`, `generalv3.5`, `lite` |
| `sensenova` | 商汤日日新（SenseNova） | `openai-compatible` | `https://api.sensenova.cn/compatible-mode/v1` | `SenseChat-5`, `SenseChat-Turbo` |
| `mimo` | 小米 MiMo | `openai-compatible` | `https://api.xiaomimimo.com/v1` | `MiMo-7B-RL` |

### 6.2 海外主流大模型（13 项）

| 预设 ID | 名称 | 协议 (`provider`) | 默认 Base URL | 预置常用模型候选 |
| :--- | :--- | :--- | :--- | :--- |
| `openai` | OpenAI 官方（Chat Completions） | `openai-compatible` | `https://api.openai.com/v1` | `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `o4-mini`, `o3` |
| `openai-responses` | OpenAI 官方（Responses API 原生协议） | `openai-responses` | `https://api.openai.com/v1` | `gpt-5`, `gpt-5-mini`, `gpt-5-codex`, `o4-mini`, `o3` |
| `anthropic` | Anthropic（Claude 官方） | `anthropic` | `https://api.anthropic.com` | `claude-sonnet-4-5`, `claude-haiku-4-5`, `claude-opus-4-1` |
| `gemini` | Google Gemini（官方原生协议） | `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| `gemini-openai` | Google Gemini（OpenAI 兼容端点） | `openai-compatible` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| `xai` | xAI（Grok 官方） | `openai-compatible` | `https://api.x.ai/v1` | `grok-4`, `grok-3`, `grok-3-mini` |
| `mistral` | Mistral AI（Codestral / Mistral） | `openai-compatible` | `https://api.mistral.ai/v1` | `mistral-large-latest`, `codestral-latest`, `ministral-8b-latest` |
| `cohere` | Cohere（V2 原生协议） | `cohere` | `https://api.cohere.com/v2` | `command-a-03-2025`, `command-r-plus-08-2024`, `command-r-08-2024` |
| `azure-openai` | Azure OpenAI Service | `azure-openai` | `https://YOUR_RESOURCE.openai.azure.com` | `gpt-5`, `gpt-4.1`, `o4-mini` |
| `bedrock` | Amazon Bedrock（OpenAI 兼容端点） | `openai-compatible` | `https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1` | `anthropic.claude-sonnet-4-5-20250929-v1:0`, `us.deepseek.r1-v1:0` |
| `perplexity` | Perplexity（Sonar 联网搜索模型） | `openai-compatible` | `https://api.perplexity.ai` | `sonar-pro`, `sonar-reasoning-pro`, `sonar` |
| `nvidia-nim` | NVIDIA NIM | `openai-compatible` | `https://integrate.api.nvidia.com/v1` | `deepseek-ai/deepseek-r1`, `meta/llama-3.3-70b-instruct`, `qwen/qwen2.5-coder-32b-instruct` |
| `github-models` | GitHub Models | `openai-compatible` | `https://models.github.ai/inference` | `openai/gpt-4.1`, `deepseek/DeepSeek-R1`, `xai/grok-3` |

### 6.3 聚合网关与算力云（11 项）

| 预设 ID | 名称 | 协议 (`provider`) | 默认 Base URL | 预置常用模型候选 |
| :--- | :--- | :--- | :--- | :--- |
| `siliconflow` | 硅基流动（SiliconFlow） | `openai-compatible` | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3`, `deepseek-ai/DeepSeek-R1`, `Qwen/Qwen3-235B-A22B`, `zai-org/GLM-4.5` |
| `openrouter` | OpenRouter（全球多模型聚合） | `openai-compatible` | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4.5`, `google/gemini-2.5-pro`, `openai/gpt-5`, `deepseek/deepseek-chat-v3` |
| `groq` | Groq（LPU 超高速推理） | `openai-compatible` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile`, `deepseek-r1-distill-llama-70b`, `qwen-qwq-32b` |
| `together` | Together AI | `openai-compatible` | `https://api.together.xyz/v1` | `deepseek-ai/DeepSeek-R1`, `deepseek-ai/DeepSeek-V3`, `Qwen/Qwen2.5-Coder-32B-Instruct` |
| `fireworks` | Fireworks AI | `openai-compatible` | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/deepseek-v3`, `accounts/fireworks/models/deepseek-r1` |
| `cerebras` | Cerebras Inference | `openai-compatible` | `https://api.cerebras.ai/v1` | `llama-3.3-70b`, `qwen-3-32b`, `llama3.1-8b` |
| `deepinfra` | DeepInfra | `openai-compatible` | `https://api.deepinfra.com/v1/openai` | `deepseek-ai/DeepSeek-R1`, `deepseek-ai/DeepSeek-V3`, `Qwen/Qwen2.5-Coder-32B-Instruct` |
| `sambanova` | SambaNova Cloud | `openai-compatible` | `https://api.sambanova.ai/v1` | `DeepSeek-R1`, `DeepSeek-V3-0324`, `Meta-Llama-3.3-70B-Instruct` |
| `novita` | Novita AI | `openai-compatible` | `https://api.novita.ai/v3/openai` | `deepseek/deepseek-r1`, `deepseek/deepseek-v3` |
| `modelscope` | 魔搭社区（ModelScope API-Inference） | `openai-compatible` | `https://api-inference.modelscope.cn/v1` | `Qwen/Qwen3-235B-A22B`, `deepseek-ai/DeepSeek-R1`, `deepseek-ai/DeepSeek-V3` |
| `ppio` | PPIO 派欧算力云 | `openai-compatible` | `https://api.ppinfra.com/v3/openai` | `deepseek/deepseek-r1`, `deepseek/deepseek-v3`, `qwen/qwen2.5-coder-32b-instruct` |
| `gitee-ai` | 模力方舟（Gitee AI） | `openai-compatible` | `https://ai.gitee.com/v1` | `DeepSeek-R1`, `DeepSeek-V3`, `Qwen2.5-Coder-32B-Instruct` |

### 6.4 本地部署与自建网关（7 项，本地地址均支持免填 API Key）

| 预设 ID | 名称 | 协议 (`provider`) | 默认 Base URL | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `ollama-native` | Ollama（本地原生协议 `/api/chat`） | `ollama` | `http://localhost:11434` | 走 Ollama 原生 `/api/chat` 与 `/api/tags`、`/api/show`，免密调用 |
| `ollama` | Ollama（OpenAI 兼容 `/v1`） | `openai-compatible` | `http://localhost:11434/v1` | 走 Ollama 的 OpenAI 兼容层，免密调用 |
| `lmstudio` | LM Studio（本地服务） | `openai-compatible` | `http://localhost:1234/v1` | 免密调用，支持一键拉取本地已加载模型 |
| `vllm` | vLLM（本地/私有化推理服务） | `openai-compatible` | `http://localhost:8000/v1` | 适配 vLLM / SGLang OpenAI Server |
| `llamacpp` | llama.cpp Server（本地服务） | `openai-compatible` | `http://localhost:8080/v1` | 适配 `llama-server` |
| `xinference` | Xinference（Xorbits Inference） | `openai-compatible` | `http://localhost:9997/v1` | 适配 Xinference 本地集群 |
| `oneapi` | OneAPI / NewAPI（自建聚合网关） | `openai-compatible` | `http://localhost:3000/v1` | 适配 OneAPI / NewAPI / LiteLLM 等自建转发网关 |
