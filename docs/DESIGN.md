# StableWorker 系统架构与核心技术设计（v0.9.7）

本文档阐述 StableWorker 的整体架构、进程间通信（IPC）、Agent Loop 代理循环、三级上下文管理、会话事务存储、文件检查点回滚以及精确计费与可观测性设计。

---

## 1. 整体架构与三进程模型

StableWorker 基于 **Electron 44 + React 19 + TypeScript 5.9** 构建，采用严格隔离的三进程架构：

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           Renderer Process (React 19)                      │
│  ┌──────────────┐  ┌───────────────────────────┐  ┌─────────────────────┐  │
│  │ store.ts     │  │ actions.ts (业务动作收敛)   │  │ 主窗口 & 独立工具窗  │  │
│  │ (外部状态源)  │  │ 乐观版本同步 / 流式事件组装 │  │ Inspector / Context │  │
│  └──────┬───────┘  └─────────────┬─────────────┘  └──────────┬──────────┘  │
└─────────┼────────────────────────┼───────────────────────────┼─────────────┘
          │                        │ window.api.*              │
┌─────────┼────────────────────────▼───────────────────────────┼─────────────┐
│         │              Preload Bridge (contextBridge)        │             │
│         │              src/preload/index.ts                  │             │
└─────────┼────────────────────────┬───────────────────────────┼─────────────┘
          │ chat:event (流式推送)   │ ipcRenderer.invoke (RPC)  │
┌─────────▼────────────────────────▼───────────────────────────▼─────────────┐
│                            Main Process (Node.js)                          │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  │
│  │ Agent & LLM 层    │  │ 工具与扩展层      │  │ 存储与工作区引擎          │  │
│  │ llm.ts           │  │ tools/*          │  │ sessions.ts (JSONL CAS)  │  │
│  │ compact.ts       │  │ mcp.ts           │  │ fileHistory.ts (快照)     │  │
│  │ microCompact.ts  │  │ subagent.ts      │  │ office*.ts + Worker      │  │
│  │ contextTrim.ts   │  │ hooks.ts         │  │ videoMode.ts / pipeline  │  │
│  │ modelContexts.ts │  │ approvals.ts     │  │ config.ts (safeStorage)  │  │
│  │ pricing/debug.ts │  │ permissions.ts   │  │ updater.ts               │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 安全基线
- **渲染进程无 Node.js 权限**：`nodeIntegration: false`、`contextIsolation: true`，渲染进程仅能通过 `src/preload/index.ts` 暴露的 `window.api` 调用白名单通道。
- **API Key 主进程隔离与系统级加密**：API Key 在落盘前通过 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux Secret Service）加密为 `enc:v1:...` 存储于 `config.json`；渲染进程读取配置时仅获得布尔标识 `hasApiKey` 与掩码提示 `apiKeyHint: "••••"`，明文密钥永不进入渲染进程。
- **多窗口架构**：除主窗口外，API 调试面板（`?page=inspector`）、上下文管理窗口（`?page=context`）和全局搜索窗口（`?page=search`）均为独立 `BrowserWindow` 实例，通过主进程广播事件（`sessions:changed`、`debug:updated`、`config:updated`）保持实时状态一致。

---

## 2. 模块目录结构与职责映射

```text
src/
├── shared/                        # 跨进程共享纯函数与类型定义（零 Node/DOM 依赖）
│   ├── types.ts                   # 全局唯一类型真相源（配置、会话、消息块、IPC 载荷）
│   ├── contextUsage.ts            # 7 种协议的端点归一化、同源配置比对、当前会话上下文筛选
│   ├── money.ts                   # BigInt 精确十进制算术（10^12 pico 精度，零浮点误差）
│   ├── diff.ts                    # 手写行级 LCS diff 算法（生成红绿对比 hunk）
│   ├── skillFrontmatter.ts        # 斜杠技能 YAML frontmatter 解析与 $参数替换
│   └── tokens.ts                  # 本地启发式 Token 估算（区分 CJK 与 ASCII 权重）
├── main/                          # Electron 主进程
│   ├── index.ts                   # 应用生命周期、窗口控制、全局 IPC 注册入口
│   ├── config.ts                  # 配置持久化、safeStorage 加解密、旧版配置平滑迁移
│   ├── llm.ts                     # 7 协议请求构建、SSE/NDJSON 流式解析、50 轮 Agent Loop
│   ├── withRetry.ts               # 指数退避重试（识别 408/429/5xx、Retry-After、欠费免重试）
│   ├── modelContexts.ts           # 模型上下文容量探测、三级回退与本地缓存
│   ├── microCompact.ts            # 第一级压缩：长工具输出就地折叠
│   ├── compact.ts                 # 第二级压缩：早期历史大模型结构化摘要
│   ├── contextTrim.ts             # 预算兜底裁剪：按完整对话回合整组丢弃
│   ├── contextManage.ts           # 上下文窗口 IPC、手动/自动压缩、多平台余额查询
│   ├── sessions.ts                # Append-only JSONL 事务存储、revision CAS 校验、分叉与回退
│   ├── fileHistory.ts             # 写改工具执行前文件字节级快照、逆序恢复与二次撤销快照
│   ├── approvals.ts               # 危险操作批准门 & ask_user_question 挂起/唤醒状态机
│   ├── permissions.ts             # allow / ask / deny 规则匹配与一键建议生成
│   ├── subagent.ts                # 子代理（task 工具）上下文隔离、并发批次调度
│   ├── mcp.ts                     # MCP 客户端（stdio 进程树 + Streamable HTTP 双传输）
│   ├── hooks.ts                   # 生命周期钩子（preToolUse / postToolUse / stop）
│   ├── skills.ts                  # 斜杠命令扫描、!`命令` 内嵌执行与模板展开
│   ├── agentsMd.ts                # 分层 AGENTS.md 记忆扫描（全局 → 项目根 → 子目录）
│   ├── memoryDir.ts               # 项目隔离的跨会话持久 memory 目录工具
│   ├── pricing.ts                 # 分时计费（北京时间高峰/空闲 + 节假日表）
│   ├── debug.ts                   # API 调试原始请求/响应落盘（userData/api_log/）
│   ├── office*.ts                 # 独立办公工作区、文档读写、保留模板编辑、公式 Worker、本地 OCR
│   ├── videoMode.ts / compose.ts  # 独立视频工作区、Edge-TTS 配音、FFmpeg 下载与分镜合成
│   ├── pipelineStore.ts / Runner  # 聊天驱动的视频/多模态 DAG 流水线存储与拓扑执行器
│   └── tools/                     # 工具注册中心与各领域工具实现
├── preload/
│   └── index.ts                   # contextBridge 安全桥接层
└── renderer/src/                  # React 19 前端视图层
    ├── store.ts                   # 基于 useSyncExternalStore 的轻量响应式状态树
    ├── actions.ts                 # 全部业务动作、CAS 乐观保存队列、流式事件归并、自动压缩触发
    ├── i18n.ts                    # 中/英双语即时切换字典
    └── components/                # 聊天工作台、办公/视频/文件侧栏、设置中心、独立窗口组件
```

---

## 3. Agent Loop 代理循环与消息模型

### 3.1 协议无关的消息块（`MessageBlock`）
UI 与会话存储统一采用块级结构，一条 `assistant` 消息由有序的 `MessageBlock[]` 组成：
1. `ReasoningBlock` (`{ type: 'reasoning', text, signature? }`)：模型的思考过程（DeepSeek/OpenAI `reasoning_content`、Anthropic `thinking` + `signature`、Gemini `thought: true`、Ollama `thinking`）。
2. `TextBlock` (`{ type: 'text', text }`)：Markdown 正文回复。
3. `ToolUseBlock` (`{ type: 'tool_use', id, name, input, status, output?, result?, rolledBack? }`)：工具调用及其状态（`pending_approval` → `running` → `done` / `error`）与返回结果。

### 3.2 `toApiTurns()` 历史规整算法
在向大模型发起请求前，`src/main/llm.ts` 中的 `toApiTurns()` 将 UI 消息历史转换为协议无关的 `ApiTurn[]`：
- **单回合聚合**：将同一条助手消息中的 `reasoning`、`text` 与所有已完成的 `tool_use` 聚合为一个 `assistant` 回合，紧随一个包含全部工具输出的 `tool_results` 回合（避免按单工具拆碎导致 DeepSeek R1/V3 thinking 模式报缺少 `reasoning_content` 的 400 错误）。
- **过滤未完成调用**：处于中断或未批准状态的 `tool_use` 不会进入请求历史，防止协议层因缺少配对 `tool_result` 报错。
- **角色严格交替**：相邻同角色回合自动合并；若裁剪后首条消息为 `assistant`，自动在头部补入合成用户回合 `（继续）`。

### 3.3 50 轮代理循环与并发批次执行
1. **单轮流式请求**：通过 `withRetry` 包裹流式 HTTP 调用（自动对 `408/409/429/5xx` 及网络抖动做指数退避重试，遇到 402 或余额不足报文立即终止并提示充值）。
2. **工具调用批次划分（`parallelBatches`）**：
   - 连续的**只读工具**（`kind === 'read'`，如 `read_file`、`glob`、`grep`、`web_fetch`、`web_search`）与**子代理调用**（`task`）被归入同一并行批次，通过 `Promise.all` 并发执行。
   - **写改/命令工具**（`write_file`、`edit_file`、`multi_edit`、`run_command` 等）单独成批串行执行，确保文件快照与权限审批顺序确定。
3. **Hooks 生命周期拦截**：
   - `preToolUse`：工具执行前触发用户配置的外部命令（stdin 传入 JSON 载荷）；退出码 `2` 拒绝执行并将 stderr 反馈给模型，退出码 `0` 放行，崩溃/超时默认 `fail-open` 不阻塞主流程。
   - `postToolUse`：工具执行后触发。
   - `stop`：整轮代理循环结束前触发。
4. **轮次上限收敛**：最多循环 `MAX_TOOL_ROUNDS = 50` 轮；若达到第 50 轮仍有未决工具调用，自动发起一次不带工具的汇总请求，向用户交代已完成进展与剩余步骤。

---

## 4. 三级上下文压缩与水位治理

为支持超长编程与办公会话而不触发上下文溢出（Context Overflow），StableWorker 设计了三级递进式上下文治理管线：

```
原始历史 ──▶ [1] microCompact (微压缩) ──▶ [2] summarizeWithModel (摘要压缩) ──▶ [3] trimHistory (整组裁剪兜底)
```

1. **第一级：微压缩（`src/main/microCompact.ts`）**
   - 当消息历史估算 Token 超过模型上下文窗口的 `microCompactRatio`（默认 `55%`，可在「设置 → 上下文压缩」在 `30%–80%` 间调整）时触发。
   - 保留最近 `microCompactKeep`（默认 `2` 轮）完整工具输出，将更早回合中体积超过阈值的大段工具输出（如长文件读取、长搜索结果）在请求体中替换为一行精简占位符，既大幅降低输入 Token，又保留工具调用脉络。
2. **第二级：模型结构化摘要（`src/main/compact.ts`）**
   - 当微压缩后仍超出安全预算（上下文上限的 `70%`）且被裁前缀满足 `worthSummarizing`（≥2 条消息且 >300 Tokens）时，调用当前模型（非流式）将被裁前缀压缩为结构化摘要（保留原始目标、已改文件路径、关键决策与遗留问题），并通过 `mergeSummaryIntoFirstUser` 注入保留部分的首条用户消息。
   - 摘要结果在进程内按会话缓存（`compactCache`），并可通过 `appendSummaryLine` 写入会话 JSONL 事务。
3. **第三级：整组对话裁剪兜底（`src/main/contextTrim.ts`）**
   - 若摘要请求失败或预算极小，从最旧的完整用户回合（User + 紧随的 Assistant/Tool 回合）整组丢弃，绝不从工具调用中间截断，且至少保留最后一组对话。
4. **渲染端 80% 水位自动压缩（`maybeAutoCompact`）**
   - 每轮回复落盘后，`src/renderer/src/actions.ts` 读取服务端真实返回的 `inputTokens`；若达到当前模型真实容量的 `80%`（且会话消息 ≥6 条、距上次自动压缩 >5 分钟），自动触发 `compactNow` 全量压缩并广播刷新。

---

## 5. 会话持久化、CAS 并发控制与文件检查点

### 5.1 Append-only JSONL 事务存储（`src/main/sessions.ts`）
- 每个会话对应一个独立的 `<sessionId>.jsonl` 文件（编程模式位于 `userData/sessions/<projectId>/`，办公/视频模式位于各自受管目录）。
- **追加式事务（Append-only）**：文件首行为 `header`（记录 `id`、`title`、`taskMode`、`llmId` 等元数据），后续每一行都是一个带单调递增 `revision` 的原子事务（`append`、`replace`、`delete`、`clear`、`summary`、`meta`）。
- **损坏自愈**：读取会话时逐行解析 JSONL，若因断电或崩溃导致末尾出现半截损坏行，自动跳过损坏行并恢复全部有效历史，同时向前端返回 `damaged: true` 与损坏行数提醒用户。

### 5.2 `revision` CAS（Compare-And-Swap）乐观锁
- 主进程与渲染进程共同维护会话的 `revision` 版本号。
- 渲染进程通过 `sessionSaveQueue` 串行化保存请求；主进程在执行 `saveSession` 或 `chat:send` 时校验传入的 `revision` 是否等于磁盘当前版本。
- 若用户在「上下文管理窗口」编辑、删除或压缩了消息，主进程递增 `revision` 并广播 `sessions:changed`；主窗口检测到版本推进或 CAS 冲突时，立即中止旧生成流、从磁盘重载最新会话，杜绝旧内存快照覆盖外部修改。

### 5.3 文件检查点与双向回滚（`src/main/fileHistory.ts`）
- 每当模型调用写改类工具（`write_file`、`edit_file`、`multi_edit` 或办公文档创建/编辑）修改文件前，`snapshotFilesBeforeChange` 会在 `userData/checkpoints/<sessionId>/<toolUseId>/` 下保存目标文件的字节级备份（若文件原本不存在则记录为新建标记）。
- 用户点击工具卡片上的「回滚」或消息上的「⏪ 回到这里（同时恢复文件）」时：
  1. 先对当前磁盘状态再拍一份快照（支持二次回滚撤销本次回滚）；
  2. 按时间逆序恢复被改文件、删除新建文件；
  3. 单会话最多保留 100 份快照，超限自动滚动淘汰最旧快照。

---

## 6. 精确计费引擎与 API 调试面板

### 6.1 BigInt 精确十进制计费（`src/shared/money.ts` & `src/main/pricing.ts`）
- 彻底摒弃 IEEE 754 浮点数算钱，所有单价（元或美元 / 百万 Token）与 Token 数量均转换为 **Pico 单位（$10^{-12}$）** 的 `BigInt` 整数运算。
- 支持**分时定价**：可按北京时间窗口（如 DeepSeek 高峰时段 `08:30–00:30`）与自定义节假日表自动判定高峰（Peak）与空闲（Off-peak）费率，并分别核算缓存命中（Cache Hit）与未命中（Cache Miss）输入费用。

### 6.2 API 调试悬浮窗（`src/main/debug.ts` & `ApiInspector.tsx`）
- 每一次模型请求（主对话、子代理、标题生成、连接测试）都会在 `userData/api_log/` 下生成独立的 JSON 记录文件。
- 完整记录：请求方法与 URL、脱敏后的请求头（自动掩码 `Authorization`、`x-api-key`、`api-key`、`x-goog-api-key`）、格式化请求体、直连/代理状态、HTTP 状态码与耗时、组装后的正文/思考/工具调用、上下文 Token 构成拆分（系统提示词 / 工具定义 / 消息历史）以及每一行原始 SSE/NDJSON 事件流。
