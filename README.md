# StableWorker

自研 AI 编程与办公助手（Electron 桌面应用，Windows / macOS / Linux）。当前开发分支 **v0.9.4**：
多项目管理、会话树、流式对话（Markdown 渲染）、工具调用代理循环（读 / 写 / 改 / 跑命令）、
子代理（task 工具）、Hooks 生命周期钩子、分层记忆与 memory 工具、@文件引用、MCP（stdio / HTTP）、
多模型配置档、批准模式、精确计费、上下文管理与水位条、API 调试悬浮窗及更新检查，
以及独立办公任务、附件导入和真实办公文件生成。

安装包见 [GitHub Releases](https://github.com/davidapp/stableworker/releases)。
**已发布的 v0.9.0 有已知更新缺陷**：Windows 更新元数据与资产名不一致；macOS 缺少 ZIP 且未签名，
不能依赖自动更新。手动下载安装包仍需留意系统信任提示；三平台安装和升级尚未完成设备验收。
本分支的修复须随新版本发布才会进入客户端，详见 [发布检查与升级说明](docs/releasing.md)。

## 快速开始

```bash
npm install        # 首次安装；若 electron 二进制下载失败，见下方"常见问题"
npm run dev        # 启动开发模式（带热更新）
npm run build      # 产物构建到 out/
npm run typecheck  # TypeScript 类型检查
npm run dist       # 打包当前平台（Windows NSIS / macOS DMG+ZIP / Linux AppImage）到 release/
npm run verify:release # 检查更新元数据、安装包及 SHA-512；不等同于安装测试
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

## 独立办公模式

侧栏顶部选择 **办公** → **新建办公任务**。无需选择代码目录或建立 Git 仓库。
配置模型后，可以直接描述工作，或通过输入框的附件按钮、右侧 **添加资料** 导入文件。
文件会复制到当前任务，原始资料保持在用户原来的位置。

| 模式 | 工作范围 | 主要工具 | 输出 |
| --- | --- | --- | --- |
| 编程 | 用户选择的项目目录 | 读写代码、搜索、命令和子代理 | 项目文件 |
| 办公 | 每个任务独立的本地目录 | 提取资料、创建文档、数据表和演示文稿 | Word / Excel / PPT / PDF |

- 支持导入 DOCX、XLSX、PPTX、PDF、TXT、Markdown、CSV；单文件最多 25 MB。
- `office_read_document` 提取文本、表格和幻灯片内容，长文档可分段读取；扫描 PDF 自动在本机识别无文字页。
- `office_create_document` 创建真实 DOCX、XLSX、PPTX、PDF，并重新解析验证后报告成功。
  导入资料位于 `inputs/`，结果位于 `outputs/`；已有文件不覆盖，修改时生成新副本。
- 右侧 **任务文件** 显示参考资料与生成结果；点击文件预览提取内容，点击打开按钮使用本地应用查看完整排版。
- 两种模式共享模型配置、批准模式、权限规则和 MCP；办公模式默认不提供编码写入和命令工具。
  规划模式只读，生成文件按现有批准设置执行。产物支持检查点回滚，二进制备份按字节保存。
- 办公任务保存在 `userData/office/sessions/<sessionId>/`，会话文件单独持久化。
  删除办公任务会同时删除该任务的导入副本和生成文件。

**公式计算**：新建表格可用 `{formula:"SUM(B2:B5)"}` 单元格，保存公式及真实计算结果。
现有表格通过 `office_calculate_spreadsheet` 重算并另存，支持 SUM、AVERAGE、IF、COUNTIF、SUMIF、
常用数学/查找函数、跨工作表引用和公式依赖。计算在线程中执行，停止时终止线程；
不支持的函数、外部引用、宏或数组公式会清除旧缓存并明确列出错误，不冒充成功结果。

**扫描 PDF OCR**：随应用附带简体中文与英文模型，在本机识别，文档不上传，首次使用也不需下载语言包。
自动保留原生文字、识别前 10 个无文字页；可用 `office_ocr_pdf` 的 `pages` 参数继续分批处理，每批最多 30 页。
返回每页来源与识别置信度，模糊扫描件的数字和文字需要复核。右侧 PDF 文件提供「识别扫描文字」入口。

**保留模板编辑**：`office_inspect_document` 给出原文件的段落和单元格位置，`office_edit_document`
在指定位置修改内容，并将其他 XML 部件、图片、样式、页眉页脚、图表及合并区域保持原样。
Word/PPT 支持跨文字片段替换；Excel 支持单元格值或公式修改并重算。右侧文件的编辑按钮可将请求填入输入框。
所有修改另存新副本，原始资料不覆盖；位置歧义、数字签名、字段/修订、共享公式等不支持的编辑位置会明确拒绝。
文本长度变化仍可能引起 Word 自然换行或分页，应使用本地 Office 应用检查最终排版。

上述能力不依赖用户安装 Python 或 LibreOffice；未提供 VBA、全套 Excel 专用函数或 PDF 正文重排编辑。
语言模型来源及许可证见 [本地 OCR 资源](resources/ocr/tessdata/sources.json)。

## 工具调用（Agent Loop 的核心）

这是 StableWorker 从"聊天机器人"变成"代理"的关键机制，代码在 `src/main/tools/` 与 `src/main/llm.ts`：

```
用户消息 ─▶ 主进程流式请求模型 ─▶ 模型返回 tool_use（如 read_file{path:"src/main/llm.ts"}）
              ▲                                │
              │                                ▼
        结果回传给模型 ◀── 主进程执行工具（路径限制在项目目录内）
              │
              └─ 模型继续思考，可能再次调用工具 …… 直到给出纯文本回复（最多 50 轮工具调用，之后汇总当前进展）
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
- **安全底线**：执行入口严格校验当前允许的工具池，关闭或当前模式不可用的工具不会执行。
  文件工具在主进程执行，检查真实路径及符号链接越界；`run_command`
  超时强杀整个进程树（Windows 用 taskkill /T）；写入内容上限 500KB；输出截断到 2 万字符；
  异常一律转成错误结果喂回模型（模型能看到失败原因并自行调整）
- **停止与连接更新**：停止和工具超时传到实际进程/网络请求；命令终止整个进程组，
  MCP 发出协议取消通知并结束本地等待。MCP 禁用或配置变更会撤销旧工具、断开并按新配置连接；
  过期的排队重连不会重新启用已禁用的服务器。
- **流式工具调用解析**：OpenAI 的 `delta.tool_calls` 按 index 分片累积 `arguments`；
  Anthropic 用 `content_block_start` / `input_json_delta` / `content_block_stop` 组装——
  在 API 调试面板里可以看到这些原始事件
  完整结束信号、内容块和工具参数校验通过后才执行工具；服务错误与提前断流不会当成成功。

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
| electron-builder | 26 | 三平台打包（NSIS / DMG+ZIP / AppImage） |

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
│   ├── sessions.ts        #   会话存储：JSONL事务 + revision CAS + 旧格式自动迁移
│   ├── office.ts          #   办公任务目录、附件导入与产物IPC
│   ├── officeDocuments.ts #   DOCX / XLSX / PPTX / PDF 提取与生成
│   ├── tools/office.ts    #   办公工具及输入校验
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
- **真实模型容量**：按协议、服务地址和准确模型名获取 `/models` 元数据，输入窗口与输出上限分别保存。
  优先使用服务返回值；服务未提供时使用 [已核实的官方配置](config/model-contexts.json)，未知模型显示“上限未确认”，不会猜成 32k。
  容量缓存固化在 `userData/model-contexts.json`（macOS 通常为 `~/Library/Application Support/stableworker/model-contexts.json`），
  记录来源与核实时间，不保存密钥。保存或切换模型会更新当前容量，可在水位详情或 LLM 设置中点击刷新；
  特殊服务也可在模型配置中显式填写手动容量。旧版全局 `contextLimit` 仅归档为 `legacyContextLimit`，不再作为模型真实容量。
  水位只读取当前会话、当前模型配置的主代理请求，旧版没有会话身份的日志不用于计算水位，等待下一次请求获得真实用量。
- **会话存储（append-only JSONL）**：每会话一个 `.jsonl`，单行事务包含 revision 与一组操作，
  只追加不重写；消息编辑、删除、清空及摘要都有真实持久化。写入按会话串行且校验版本，
  旧窗口快照不能覆盖新历史。生成期间其他窗口改动历史会停止本轮并重载，避免旧回复复活已清空的内容。
  截断事务整行跳过，旧 JSON / JSONL 继续兼容（`src/main/sessions.ts`）。
- **多配置档**：`llmProfiles` + `activeLlmId`，输入框下方随时切换；旧版单配置加载时自动迁移
- **批准模式**：✋ 变更前确认（所有危险操作询问）/ 🛡️ 自动编辑（`kind: 'edit'` 自动放行）/
  ⚠️ 完全访问（全部自动）；模式持久化，主进程批准门据此决定是否挂起

## 已知简化

- 流式期间每条增量都会重渲染整段 Markdown，长回复下可优化为增量渲染
- `run_command` 在 Windows 上的中文输出可能是 GBK 乱码（代码页问题）；无法运行交互式命令
- v0.9.0 未配置发行签名：Windows 可能出现 SmartScreen / 未知发布者提示；macOS 的 Gatekeeper 与自动更新受限。
  后续正式 macOS 构建必须配置 Developer ID 签名和公证；Windows 签名仍取决于证书配置（见发布说明）。
- 上下文构成拆分（消息 / 系统工具 / 系统提示词）是本地估算，非 tokenizer 精确值
