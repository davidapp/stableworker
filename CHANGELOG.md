# 更新日志（Changelog）

所有显著变更记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.9.7] — 2026-11-06

### 新增
- **7 种大模型原生 API 协议**：除 `openai-compatible` 与 `anthropic` 外，新增支持 `openai-responses`（OpenAI `/v1/responses`）、`gemini`（Google Gemini `generateContent` / `streamGenerateContent`）、`azure-openai`（Azure 部署端点与 `api-key` 鉴权）、`ollama`（Ollama 原生 `/api/chat` NDJSON 流与免密调用）、`cohere`（Cohere v2 `/v2/chat`）
- **47 个国内外主流大模型与算力网关预设**：按国内主流（DeepSeek、智谱 GLM、通义千问、Kimi、火山方舟、MiniMax、百川、零一万物、阶跃星辰、混元、千帆、星火、商汤、小米 MiMo）、海外主流（OpenAI、Claude、Gemini、xAI Grok、Mistral、Cohere、Azure OpenAI、AWS Bedrock、Perplexity、NVIDIA NIM、GitHub Models）、聚合与算力云（OpenRouter、SiliconFlow、Groq、Together、Fireworks、Cerebras、DeepInfra、SambaNova、Novita、魔搭 ModelScope、PPIO、模力方舟 Gitee AI）及本地部署（Ollama、LM Studio、vLLM、llama.cpp、Xinference、OneAPI/NewAPI）分组预置
- **模型列表拉取与余额查询扩展**：配置档编辑弹窗内新增一键"拉取模型"按钮；余额查询新增支持 OpenRouter、硅基流动（SiliconFlow）、月之暗面（Kimi）并支持代理转发

### 修复与优化
- 修复 `llm:listModels` IPC 通道被错误嵌套在 `llm:test` 内部导致未测连接时拉取模型失败、多次测试重复注册崩溃的问题
- 修复 `ask_user_question` 在会话停止时未清理挂起 Promise 的问题
- 修复 `memory` 工具写入嵌套子目录时报错 `ENOENT` 的问题
- 修复 `globToRegExp` 中 `/**/` 边界误匹配及 `grep` 单文件名 `include` 过滤在子目录失效的问题
- 增强 `web_fetch` SSRF 防护：补充 IPv6 私网/环回地址拦截，并对 HTTP 重定向逐跳校验目标地址
- 修复 `web_search` 未走配置代理及 `baseURL` 尾部 `/v1` 重复拼接问题
- 修复 `write_file` / `multi_edit` 后未同步更新 `fileStateCache` 及 `run_command` 前台超时转后台时丢失前期输出的问题
- 优化 Excel 公式引擎 `decimalRound` 与工作表 XML 写回性能
- 修复独立调试/上下文/搜索窗口未挂载 `ConfirmDialog`、保存配置档误关整个设置弹窗及会话独立模型在顶栏/底栏状态同步问题

## [0.9.5] — 2026-10-18

### 新增
- **会话独立模型**：每个会话可自选模型配置档，选择随会话持久化；新会话默认跟随全局激活档
- **配置档启用开关**：LLM 配置页每行滑动开关，控制该模型是否出现在聊天框的选择列表；停用激活档自动转移激活
- **MCP 资源双工具**：`mcp_list_resources` / `mcp_read_resource`，模型可直接列出并读取已连接 MCP 服务器的资源
- **Plan 工具化**：`enter_plan_mode` / `exit_plan_mode`——模型主动进入规划模式，计划经用户批准后自动切回执行
- **WebSearch 工具**：接入 DeepSeek Search API（`/v1/tools/search`，与聊天同 API Key）
- **模型列表在线获取**：配置档编辑时从服务商 `/models` 拉取可用模型；无该接口的服务商（智谱）回退内置常用模型表

### 变更
- **run_command 超时转后台**：前台命令 60 秒未结束不再杀进程，自动转入后台并返回任务 id（`task_output` 轮询 / `task_stop` 终止）
- **批准模式即时生效**：对话进行中切换批准模式立即作用于后续命令；切完全访问时自动放行全部挂起请求
- 模型菜单改为自绘圆角卡片（只显示模型名），操作收拢为行内"操作 ▾"菜单（获取模型列表 / 获取容量 / 查询余额）
- 字体栈重排（Noto Sans SC / Segoe UI，全局 500 字重，等宽数字）
- 窗口无边框化：自定义最小化/最大化/关闭移入聊天头部，头部可拖拽移动窗口
- 各面板最小宽度约束：空间不足按序压缩面板，不再横向滚动或截断

### 修复
- 批准模式中途切换不生效（此前每轮开始时快照，现门禁实时读取）
- 上下文弹层在窗口右缘被截断（改为固定定位并收进视口）
- 重复注册 `config:setProfileEnabled` 导致启动报错

## [0.9.4] — 2026-10-17

### 新增
- **消息级 rewind**：消息悬停"⏪ 回到这里"（可选同时恢复文件）与"🍴 从这里分叉"
- **文件浏览面板**（编程模式）：工作目录文件树、文件内容预览、资源管理器直达
- **原生弹窗替换**：全部确认/提示改为应用皮肤对话框（明暗主题自适应）

### 变更
- 各面板最小宽度约束；模型选择器胶囊化；LLM 配置页信息收纳进行内
- 字体栈重排（Noto Sans SC / Segoe UI，全局 500 字重，等宽数字）

### 修复
- 办公面板收起状态不生效（ConfigView 漏字段）
- web_search 工具未注册进工具池

## [0.9.3] — 2026-10-17

### 新增
- **MCP 完整接入**：stdio + Streamable HTTP 双传输、设置页管理（含智谱无 /models 的回退模型表）、MCP 资源双工具、Plan 工具化、WebSearch 工具
- **配置档启用开关**（初版，行内开关）
- **应用偏好**：中英文界面语言、明亮/暗黑主题（侧栏界面菜单）
- **无边框窗口**：自定义窗口控制移入聊天头部

### 修复
- 会话删除确认弹窗样式
- 重复注册 IPC 通道导致启动报错

## [0.9.2] — 2026-10-16

### 新增
- **操作 ▾ 收拢**：获取模型列表 / 获取容量 / 查询余额收拢为配置档行内菜单
- 模型选择器只显示模型名；字体优化（Noto Sans SC / Segoe UI，全局 500 字重）

### 修复
- ContextMeter 弹层在窗口右缘被截断（固定定位收进视口）
- 重复注册 IPC 通道导致启动报错

## [0.9.1] — 2026-10-16

### 新增
- **消息级 rewind**、**文件浏览面板**、**原生弹窗替换**（同 0.9.4 内容的首次落地）

### 修复
- web_search 工具漏注册
- 办公面板收起不生效（ConfigView 漏字段）

## [0.9.0] — 2026-10-11

首个公开标签：多项目管理、会话树、流式对话（Markdown 渲染）、工具调用代理循环、
多模型配置档、批准模式、精确计费（分时 + BigInt）、上下文水位条、API 调试悬浮窗、
三平台 CI 安装包。

> 已知缺陷：Windows 更新元数据与资产名不一致；macOS 缺 ZIP 且未签名。
> 两者均已在后续版本修复（更新链路 v0.9.2 起可用；macOS 签名等待证书）。

[0.9.5]: https://github.com/davidapp/stableworker/releases/tag/v0.9.5
[0.9.4]: https://github.com/davidapp/stableworker/releases/tag/v0.9.4
[0.9.3]: https://github.com/davidapp/stableworker/releases/tag/v0.9.3
[0.9.2]: https://github.com/davidapp/stableworker/releases/tag/v0.9.2
[0.9.1]: https://github.com/davidapp/stableworker/releases/tag/v0.9.1
[0.9.0]: https://github.com/davidapp/stableworker/releases/tag/v0.9.0
