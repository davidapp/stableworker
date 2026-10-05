# StableWorker

自研 AI 代理编程软件（Electron 桌面应用，Windows / macOS / Linux）。当前版本 **v0.6.0**：
多项目管理、会话树、流式对话（Markdown 渲染）、工具调用代理循环（读 / 写 / 改 / 跑命令）、
多模型配置档、批准模式、精确计费、上下文管理与水位条、API 调试悬浮窗。

## 快速开始

```bash
npm install        # 首次安装；若 electron 二进制下载失败，见下方"常见问题"
npm run dev        # 启动开发模式（带热更新）
npm run build      # 产物构建到 out/
npm run typecheck  # TypeScript 类型检查
npm run dist       # 打包当前平台的安装器（Windows NSIS / macOS DMG / Linux AppImage）到 release/
```

> 常见问题：如果 `npm run dev` 报 `Error: Electron uninstall`，是 Electron 二进制没下载成功（网络原因）。
> 执行 `cd node_modules/electron && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node install.js` 即可。

## 使用流程

1. 左侧 **＋ 新建项目** —— 选一个本地目录作为工作区（可添加多个）；项目行上的 **＋** 在该项目下新建会话
2. 会话以**叶子节点**形式挂在项目下：点击打开，右键**重命名 / 删除**，叶子右侧 **×** 快速删除
3. **⚙ 设置 → LLM 配置** —— 配置档管理器：添加**多套模型配置**（不同服务商 / 模型 / 代理），
   新增 / 编辑 / 删除 / 一键切换激活；编辑器里有预设快填（DeepSeek / GLM / Kimi / Anthropic / OpenAI /
   Ollama 本地）和官方文档链接；另有**模型价格**（精确计费 + 节假日表）、**工具开关**、**功能开关**等页面
4. 输入框内部最下面一行 —— 左侧**批准模式**（✋ 变更前确认 / 🛡️ 自动编辑 / ⚠️ 完全访问）；
   右侧上下文圆环（点击看构成明细与缓存命中率）、**模型选择**、**🧠 思考力度**、发送按钮
5. 发消息 —— 助手回复以 **Markdown 渲染**；涉及项目内容时会**调用工具**（读 / 写 / 改 / 跑命令），
   气泡里出现工具卡片：写改类操作按批准模式确认，编辑带红绿 diff，命令执行有实时输出
6. **API 调试** —— 菜单 **窗口 → API 调试**（Ctrl+Alt+D）打开独立悬浮窗口（置顶），
   观察每轮调用的原始请求 / SSE 事件流 / token 用量与费用

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

- **消息模型**：对齐 LLM API 的 content blocks（`text` / `reasoning` / `tool_use`），工具结果挂在
  `tool_use` 块上；历史消息按整条助手消息切分成各协议要求的形状（OpenAI 的 `role:'tool'` /
  Anthropic 的 `tool_result`）——切分逻辑见 `toApiTurns()`
- **工具注册中心**：`tools/index.ts` 里每个工具 = 名称 + 描述 + JSON Schema + 执行函数 +
  风险分类（`kind`）+ 可选独立超时。当前有 `list_files`（列目录）、`read_file`（带行号读文件，
  支持 offset/limit 分段）、`write_file`（创建 / 覆盖文件）、`edit_file`（oldText/newText 精准
  字符串替换，多处匹配时要求扩大上下文或 replace_all）和 `run_command`（在项目目录执行 shell
  命令，60 秒超时强杀进程树）
- **diff 展示**：编辑类工具的卡片里渲染红绿 diff（`shared/diff.ts` 手写 LCS 行级算法），
  批准前就能看到改动内容
- **批准门**：带副作用的工具（`requiresApproval: true`）执行前循环挂起，聊天里弹出"允许 / 拒绝"
  卡片；拒绝 / 超时（120 秒）/ 停止都会作为错误结果喂回模型（它会自己调整方案）；
  实现在 `src/main/approvals.ts`——一个由 IPC 事件 resolve 的 Promise，即"主进程等待用户决策"的模式
- **实时输出**：命令执行期间 stdout/stderr 逐块推到工具卡片（`tool_output` 事件），
  面板自动滚到最新一行
- **安全底线**：工具只在主进程执行、渲染进程无执行通道；路径越界直接报错；`run_command`
  超时强杀整个进程树（Windows 用 taskkill /T）；写入内容上限 500KB；输出截断到 2 万字符；
  异常一律转成错误结果喂回模型（模型能看到失败原因并自行调整）
- **流式工具调用解析**：OpenAI 的 `delta.tool_calls` 按 index 分片累积 `arguments`；
  Anthropic 用 `content_block_start` / `input_json_delta` / `content_block_stop` 组装——
  在 API 调试面板里可以看到这些原始事件

## API 调试面板

菜单 **窗口 → API 调试** 打开独立悬浮窗口。每次 LLM 调用（对话、测试连接）都会记录，
**永久保存在本地磁盘**（`userData/api_log/`，一个调用一个 JSON 文件；"清空"按钮删除全部文件）：

- **请求**：方法 + URL、请求头（API Key 已脱敏）、完整请求体 JSON、直连 / 经代理信息
- **响应**：优先展示拼装后的完整回复；工具调用（解析后）、思考过程、token 用量 / 计费明细、
  逐条原始 SSE `data:` 事件行收在下方与"展开详情"里
- **用量与费用**：输入（拆缓存命中 / 未命中）/ 输出 token 数、本次花费——若 API 直接返回金额
  以返回值为准；否则按**模型价格表**精确计算。支持分时定价（北京时间高峰 / 空闲 + 节假日表），
  BigInt 十进制运算、金额为精确字符串不做四舍五入；列表底部有分币种累计
- 工具回合的每一轮 API 调用单独一条记录（R1 / R2 序号），对比相邻轮的请求体就能看到
  "工具结果如何回到模型"

## 技术栈

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Electron | 44.5.1 | 桌面壳，主进程 + 渲染进程 |
| electron-vite | 5.0.0 | 三段式构建（main / preload / renderer），dev 热更新 |
| Vite | 7.3.6 | 底层构建器 |
| React | 19.3.0 | 界面 |
| TypeScript | 5.9 | 全量类型覆盖（含 IPC 两端） |
| undici | 8.x | 代理支持（ProxyAgent） |
| electron-builder | 26 | 三平台打包（NSIS / DMG / AppImage） |

## 目录结构

```
src/
├── shared/                # 主/渲染进程共享（唯一真相源）
│   ├── types.ts           #   IPC 类型：配置、会话、消息 blocks、事件、调试
│   ├── money.ts           #   金额精确十进制运算（BigInt，pico 精度）
│   ├── diff.ts            #   行级 LCS diff（编辑工具的红绿对比）
│   └── tokens.ts          #   本地 token 估算启发式
├── main/                  # 主进程（Node 环境，管系统能力）
│   ├── index.ts           #   窗口创建 + 安全基线 + 注册各模块 IPC
│   ├── menu.ts            #   原生应用菜单（含 API 调试入口）
│   ├── config.ts          #   全局配置：配置档 / 价格表 / 节假日 / 功能与工具开关
│   ├── projects.ts        #   项目管理：目录选择，按规范化路径去重
│   ├── sessions.ts        #   会话存储 v2：append-only JSONL + 旧格式自动迁移
│   ├── llm.ts             #   LLM 调用（双协议 SSE 流式）+ 代理循环 + 工具调用解析
│   ├── tools/index.ts     #   工具注册中心：list_files / read_file / write_file / edit_file / run_command
│   ├── approvals.ts       #   批准门：主进程等待用户决策（Promise + IPC）
│   ├── contextTrim.ts     #   发送前历史裁剪（整组裁剪，保 tool_call/result 配对）
│   ├── pricing.ts         #   分时计费：高峰/空闲判定（北京时间+节假日）+ 精确算钱
│   ├── debug.ts           #   API 调试日志：原始请求/响应永久落盘 + 用量费用
│   ├── inspectorWindow.ts #   API 调试独立悬浮窗口
├── preload/index.ts       # 桥接层：contextBridge 暴露 window.api（渲染进程唯一入口）
└── renderer/src/
    ├── store.ts           #   极简全局 store + useSyncExternalStore
    ├── actions.ts         #   全部业务动作（组件只展示、不写逻辑）
    ├── features.ts        #   功能入口注册表（设置里可控制显隐）
    ├── clipboard.ts       #   剪贴板（含降级）
    ├── App.tsx            #   布局编排 + 侧栏拖拽分隔条
    └── components/
        ├── Sidebar / ChatPane / Composer / ToolCallCard / ContextMeter
        ├── ApprovalModeMenu / ThinkingEffortMenu / CaretIcon
        ├── ApiInspector.tsx          #   API 调试面板（独立窗口内容）
        ├── SettingsDialog.tsx        #   统一设置对话框（左侧导航外壳）
        └── settings/                 #   LLM 配置 / 模型价格 / 工具开关 / 功能开关
```

## 架构要点

**三进程模型与数据流**

```
Renderer (React)  ──window.api.xxx()──▶  Preload (contextBridge)  ──ipcRenderer.invoke──▶  Main
     ▲                                                                                        │
     └──────────────── webContents.send('chat:event', 流式增量) ◀──────────────────────────────┘
```

- 请求 / 响应类操作走 `ipcMain.handle` 一问一答；流式输出（正文、思考、工具输出）走
  单一 `chat:event` 通道，事件带 `sessionId` 区分会话
- API Key 只存在主进程：渲染进程保存时传原文、读取时只拿 `••••` 掩码
- **HTTP 代理**：Node 全局 fetch 不读系统代理环境变量——配置了 `proxyURL` 时主进程用
  undici 的 `ProxyAgent` 按请求挂 dispatcher，留空直连；同一代理地址复用同一个 agent
- **上下文管理**：环形水位条（点击看构成明细 + 缓存命中率；总量为服务端精确值、拆分为本地
  估算）；估算超上下文上限 70% 时发送前自动裁剪——从最旧**整组**丢弃，绝不拆开
  tool_calls 与 tool_result；只影响请求体，会话与界面历史保持完整（`src/main/contextTrim.ts`）
- **会话存储（append-only JSONL）**：每会话一个 `.jsonl`，每行一个操作（meta / 按 index 设
  消息 / clear / summary 摘要压缩记录），只追加不重写——写入 O(新内容)，崩溃最多损失最后半行
  （解析失败跳过）；旧版单 JSON 自动转换（`src/main/sessions.ts`）
- **多配置档**：`llmProfiles` + `activeLlmId`，输入框下方随时切换；旧版单配置加载时自动迁移
- **批准模式**：✋ 变更前确认（所有危险操作询问）/ 🛡️ 自动编辑（`kind: 'edit'` 自动放行）/
  ⚠️ 完全访问（全部自动）；模式持久化，主进程批准门据此决定是否挂起

## 已知简化

- 流式期间每条增量都会重渲染整段 Markdown，长回复下可优化为增量渲染
- `run_command` 在 Windows 上的中文输出可能是 GBK 乱码（代码页问题）；无法运行交互式命令
- 应用未做代码签名（首次运行 SmartScreen / Gatekeeper 会有提示）；应用图标为默认图标
- 上下文构成拆分（消息 / 系统工具 / 系统提示词）是本地估算，非 tokenizer 精确值
