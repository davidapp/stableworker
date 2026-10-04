# StableWorker

自研 AI 代理编程软件。当前是 **v0.1 最小可运行骨架**：Electron 桌面壳 + 项目管理 + 聊天界面（流式输出）+ LLM API 配置。

## 快速开始

```bash
npm install        # 首次安装；若 electron 二进制下载失败，见下方"常见问题"
npm run dev        # 启动开发模式（带热更新）
npm run build      # 产物构建到 out/
npm run typecheck  # TypeScript 类型检查
```

> 常见问题：如果 `npm run dev` 报 `Error: Electron uninstall`，是 Electron 二进制没下载成功（网络原因）。
> 执行 `cd node_modules/electron && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node install.js` 即可。

## 使用流程

1. 左侧 **＋ 添加项目** —— 选一个本地目录作为工作区（可添加多个，随时切换）
2. 左下角 **⚙ 设置 → LLM 配置** —— 配置档管理器：可添加**多套模型配置**（不同服务商 / 模型 / 代理），
   新增 / 编辑 / 删除 / 一键切换激活；编辑器里有预设快填（DeepSeek / GLM / Kimi / Anthropic / OpenAI /
   Ollama 本地）和官方文档链接；另外还有**模型价格**（精确计费）、**功能开关**等页面
3. 输入框内部最下面一行 —— 左侧**批准模式**（✋ 变更前确认 / 🛡️ 自动编辑 / ⚠️ 完全访问）；
   右侧**模型选择**（所有配置档随时切换）、**🧠 思考力度**（默认/低/中/高，映射到
   reasoning_effort 或 Anthropic thinking 预算）、圆形发送按钮
4. 底部输入框发消息 —— 助手回复以 **Markdown 渲染**；涉及项目内容时助手会**调用工具**查看/写入文件
   （气泡里出现工具调用卡片；写文件按批准模式确认）；Enter 发送，Shift+Enter 换行
5. 顶部可新建 / 切换 / 删除会话、**🧹 清空上下文**；会话自动持久化，重启应用后可恢复
6. 左下角 **🔍 API 调试** —— 查看每次 LLM 调用的原始请求/响应（工具回合的每轮调用单独一条，见下文）

## 工具调用（Agent Loop 的核心）

这是 StableWorker 从"聊天机器人"变成"代理"的关键机制，代码在 `src/main/tools/` 与 `src/main/llm.ts`：

```
用户消息 ─▶ 主进程流式请求模型 ─▶ 模型返回 tool_use（如 read_file{path:"src/main/llm.ts"}）
              ▲                                │
              │                                ▼
        结果回传给模型 ◀── 主进程执行工具（路径限制在项目目录内）
              │
              └─ 模型继续思考，可能再次调用工具 …… 直到给出纯文本回复（最多 8 轮）
```

- **消息模型**：对齐 LLM API 的 content blocks（`text` + `tool_use`），工具结果挂在 `tool_use` 块上；
  历史消息按"带结果的工具调用"切分成各协议要求的形状（OpenAI 的 `role:'tool'` / Anthropic 的
  `tool_result`）——切分逻辑见 `toApiTurns()`，是理解两种协议差异的最佳教材
- **工具注册中心**（借鉴 Claude Code）：`tools/index.ts` 里每个工具 = 名称 + 描述 + JSON Schema + 执行函数；
  当前有 `list_files`（列目录）、`read_file`（带行号读文件，支持 offset/limit 分段）和
  `write_file`（创建/覆盖文件，**危险操作**）
- **批准门**：带副作用的工具（`requiresApproval: true`）执行前循环挂起，聊天里弹出"允许/拒绝"卡片；
  拒绝/超时（120 秒）/停止都会作为错误结果喂回模型（它会自己调整方案）；
  实现在 `src/main/approvals.ts`——一个由 IPC 事件 resolve 的 Promise，即"主进程等待用户决策"的模式
- **安全底线**：工具只在主进程执行、渲染进程无执行通道；路径越界直接报错；15 秒超时；
  写入内容上限 500KB；结果截断到 2 万字符；异常一律转成错误结果喂回模型（模型能看到失败原因并自行调整）
- **流式工具调用解析**：OpenAI 的 `delta.tool_calls` 按 index 分片累积 `arguments`；
  Anthropic 用 `content_block_start` / `input_json_delta` / `content_block_stop` 组装——
  在 API 调试面板里可以看到这些原始事件
- **调试面板**：工具回合的每一轮 API 调用单独一条记录（带 R1/R2 序号），对比 R1 和 R2 的
  请求体就能看到"工具结果如何回到模型"

## API 调试面板（学习原理的入口）

左下角"🔍 API 调试"打开。每次 LLM 调用（对话、测试连接）都会记录，**永久保存在本地磁盘**
（`userData/api_log/` 目录，一个调用一个 JSON 文件，重启应用仍可查看；"清空"按钮会删除全部文件）：

- **请求**：方法 + URL、请求头（API Key 已脱敏）、完整请求体 JSON、直连/经代理信息
- **响应**：默认优先展示**拼装后的完整回复**；token 用量、计费明细和逐条原始 SSE `data:` 事件行
  收在"展开详情"里（流式进行时可实时观察事件流入）
- **用量与费用**：输入（拆缓存命中/未命中）/输出 token 数、本次花费——若 API 直接返回金额（如
  OpenRouter 的 `usage.cost`）以返回值为准；否则按设置里的**模型价格表**精确计算。计费支持
  DeepSeek 式分时定价：北京时间工作日 09:00–12:00、14:00–18:00 为高峰（周末与法定节假日全天空闲），
  按请求发起时刻定档；法定节假日表在 config.json 的 `holidays` 字段维护。计算全程用 BigInt
  十进制运算（pico 精度），金额以精确字符串展示，不做四舍五入。列表底部有分币种累计
- **拼装后的最终文本**：和事件流对照，就能看懂"流式输出 = 逐条提取 delta 再拼接"

对照学习要点：

- OpenAI 兼容协议：事件是 `{"choices":[{"delta":{"content":"x"}}]}`，以 `data: [DONE]` 结束；
  请求里带 `stream_options: {"include_usage": true}` 时，最后一个 chunk 会携带 token 用量
- Anthropic 协议：事件带 `type` 字段，文本增量在 `type: "content_block_delta"` 的 `delta.text` 里，
  用量在 `message_start`（输入）和 `message_delta`（累计输出）事件里
- 发送时会发现 system 提示词、消息历史的真实形状——这就是"聊天上下文"在线上的样子

调试记录保存在本地，密钥已脱敏；实现见 `src/main/debug.ts`（内存留最近 100 条完整记录，更早的按需读盘）。

## 技术栈（全部最新稳定版）

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Electron | 44.5.1 | 桌面壳，主进程 + 渲染进程 |
| electron-vite | 5.0.0 | 三段式构建（main / preload / renderer），dev 热更新 |
| Vite | 7.3.6 | 底层构建器 |
| React | 19.3.0 | 界面 |
| TypeScript | 5.9 | 全量类型覆盖（含 IPC 两端） |

## 目录结构

```
src/
├── shared/types.ts        # 主/渲染进程共享的 IPC 类型（唯一真相源）
├── main/                  # 主进程（Node 环境，管系统能力）
│   ├── index.ts           #   窗口创建 + 安全基线 + 注册各模块 IPC
│   ├── config.ts          #   全局配置：单 JSON 文件 + safeStorage 加密 API Key
│   ├── projects.ts        #   项目管理：目录选择，按规范化路径去重
│   ├── sessions.ts        #   会话持久化：每会话一个 JSON 文件
│   ├── llm.ts             #   LLM 调用：OpenAI 兼容 & Anthropic 双协议，SSE 流式，代理/计费
│   ├── pricing.ts         #   分时计费：高峰/空闲判定（北京时间+节假日表）+ BigInt 精确算钱
│   └── debug.ts           #   API 调试日志：原始请求/响应永久落盘 + 用量费用统计
├── preload/index.ts       # 桥接层：contextBridge 暴露 window.api（渲染进程唯一入口）
└── renderer/              # 界面（浏览器环境，不碰 Node）
    └── src/
        ├── store.ts       #   极简全局 store + useSyncExternalStore
        ├── actions.ts     #   全部业务动作（组件只展示、不写逻辑）
        ├── features.ts    #   功能入口注册表（新增功能登记后即可在设置里控制显隐）
        ├── App.tsx        #   布局编排
        └── components/
            ├── Sidebar / ChatPane / Composer / ApiInspector
            ├── SettingsDialog.tsx        #   统一设置对话框（左侧导航外壳）
            └── settings/                #   设置的各个页面：LLM 配置 / 模型价格 / 功能开关
```

## 架构要点（学习笔记）

**三进程模型与数据流**

```
Renderer (React)  ──window.api.xxx()──▶  Preload (contextBridge)  ──ipcRenderer.invoke──▶  Main
     ▲                                                                                        │
     └──────────────── webContents.send('chat:event', 流式增量) ◀──────────────────────────────┘
```

- 请求/响应类操作（读配置、存会话）走 `ipcMain.handle` 一问一答
- LLM 流式输出是持续推送，走单一 `chat:event` 通道，事件带 `sessionId` 区分会话
- API Key 只存在主进程：渲染进程保存时传原文、读取时只拿 `••••` 掩码
- **HTTP 代理**：Node 的全局 fetch 不读系统代理环境变量，所以代理走显式配置——配置了 `proxyURL`
  时主进程用 undici 的 `ProxyAgent` 按请求挂 dispatcher（`src/main/llm.ts`），留空直连；
  同一代理地址复用同一个 agent；每次调用的"直连/经代理"信息记录在 API 调试面板里
- **多配置档**：`llmProfiles` + `activeLlmId`，输入框下方工具条随时切换激活档；旧版单配置
  在加载时自动迁移为第一个配置档
- **批准模式**：`✋ 变更前确认`（所有危险操作询问）/ `🛡️ 自动编辑`（`kind: 'edit'` 的文件编辑
  自动放行）/ `⚠️ 完全访问`（全部自动）；模式持久化在配置里，主进程的批准门据此决定是否挂起

**从 Claude Code 源码（参考代码）吸收的设计**

1. **单一全局配置文件**（对齐 `~/.claude.json` 模式）：内存缓存 + 全量覆盖写盘
2. **项目按规范化绝对路径做唯一键**：同目录重复添加只切换激活，不会出现两个条目
3. **API Key 安全存储分层**：Electron `safeStorage` 加密（Windows 用 DPAPI），不支持时降级为带标记明文
4. **极简自建 store**（对齐其 `state/store.ts`）：`getState/setState/subscribe` 约 20 行，接 `useSyncExternalStore`，先理解原理再考虑 Zustand
5. **消息结构向 LLM API 原生形状对齐**：将来接工具调用（tool use）时不用改数据模型

## 下一步路线（建议顺序）

1. ~~Markdown 渲染 + 代码高亮~~（已完成）
2. ~~工具调用（Tool Use）~~（已完成：list_files / read_file / write_file + 代理循环 + 批准门）
3. edit_file 精准编辑 + diff 展示；工具开关（接入功能开关页）
4. 上下文管理：token 计量、历史裁剪、会话压缩
5. 会话迁移到 append-only JSONL（对齐 Claude Code，支持大文件与崩溃恢复）
6. 生产 CSP（Content-Security-Policy）与 electron-builder 打包分发

## 已知简化（相对完整产品）

- 聊天上下文是纯文本拼接，未做 token 计量与裁剪
- 单条 LLM 配置（将来扩展为多 Provider 配置档 + 每项目覆盖）
- 流式期间每条增量都会重渲染整段 Markdown，长回复下可优化为增量渲染
- 未打包安装器（`electron-vite build` 只出可运行产物）
