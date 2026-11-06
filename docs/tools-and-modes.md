# 工具系统、MCP、子代理与办公/视频引擎技术文档（v0.9.7）

本文档介绍 StableWorker 的三大工作区模式（编程 / 办公 / 视频）、工具执行与安全沙箱、批准门与权限规则、MCP 客户端、子代理调度以及办公与视频合成引擎。

---

## 1. 三大工作模式隔离架构

StableWorker 支持在侧栏顶部一键切换三种工作模式，每种模式拥有独立的会话列表、系统提示词与可用工具池（[`src/main/officeMode.ts`](../src/main/officeMode.ts)、[`src/main/videoMode.ts`](../src/main/videoMode.ts)）：

| 模式 | 项目 ID | 工作区存储路径 | 默认工具池 | 核心用途 |
| :--- | :--- | :--- | :--- | :--- |
| **编程 (`coding`)** | 用户添加的本地目录 ID | 用户选定的真实代码仓库路径 | 文件读写改、搜索、Shell 命令、Web、MCP、子代理、Memory、Plan | 代码阅读、重构、调试、自动化测试与构建 |
| **办公 (`office`)** | `office-workspace` | `userData/office/sessions/<sessionId>/` (`inputs/` & `outputs/`) | `office_*` 系列文档工具、MCP、Todo、AskUser | Word / Excel / PPT / PDF 解析、生成、保留模板修改、公式计算与扫描件 OCR |
| **视频 (`video`)** | `video-workspace` | `userData/video/sessions/<sessionId>/` | `video_*` 工具、`pipeline_*` 流水线工具、Todo、AskUser | 短视频分镜脚本编排、Edge-TTS 旁白配音、FFmpeg 字幕烧录与多模态 DAG 流水线 |

---

## 2. 编程工具链与安全边界（`src/main/tools/`）

### 2.1 核心内置工具清单
- **文件与目录**：
  - `list_files`：列出项目目录下文件结构（自动过滤 `.git`、`node_modules` 等噪声目录）。
  - `read_file`：带行号读取文件，支持 `offset` / `limit` 分页读取，并在 `fileStateCache` 中记录文件快照时间戳。
  - `write_file`：创建或覆盖文件（上限 500 KB），写入后自动更新 `fileStateCache`。
  - `edit_file` / `multi_edit`：基于精确上下文匹配的字符串替换（要求先 `read_file` 且文件未被外部篡改），卡片内实时展示行级 LCS 红绿 diff。
- **代码检索（`src/main/tools/search.ts`）**：
  - `glob`：支持 `**` 跨目录与 `*`/`?` 通配符的文件路径搜索，按修改时间倒序返回。
  - `grep`：支持正则表达式、大小写敏感控制与 `include` 文件模式过滤的高速内容检索。
- **Shell 命令与后台任务（`src/main/tools/shellTasks.ts`）**：
  - `run_command`：在项目根目录下启动子进程并实时流式推送 `stdout`/`stderr`（自动识别 UTF-8 与 Windows GBK 编码 `smartDecode.ts`）。若前台运行满 60 秒仍未结束，**不杀死进程**，而是通过 `adoptShellTask` 无缝转入后台（保留前期已收集输出）并返回 `task_id`。
  - `task_output` / `task_stop`：轮询后台命令增量输出或终止后台进程树（Windows 下调用 `taskkill /T /F`，Unix 下向负进程组 `-pid` 发送信号）。
- **联网检索（`webFetch.ts` & `webSearch.ts`）**：
  - `web_fetch`：抓取网页正文并转为精简文本。内置严格 **SSRF 防护**：拦截 `localhost`、IPv4 私网/环回/链路本地地址（`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`）及 IPv6 环回/映射/唯一本地/链路本地地址（`::1`、`::ffff:127.`、`fc00::/7`、`fe80::/10`），并对 HTTP 30x 重定向采取 `redirect: 'manual'` 逐跳重新执行 `assertPublicUrl` 校验（最多 5 跳）。
  - `web_search`：复用 DeepSeek 配置档的 API Key 与代理设置调用 `/v1/tools/search`，返回带权威度评分的搜索结果。
- **交互、规划与长期记忆**：
  - `todo_write`：维护会话级结构化任务清单（`pending` / `in_progress` / `completed`）。
  - `ask_user_question`：在对话气泡内弹出单选/多选/自由输入问题卡片，挂起等待用户回答；会话停止时由 `resolveSessionUserInputs` 安全释放。
  - `enter_plan_mode` / `exit_plan_mode`：模型主动切入只读规划模式，输出完整实现方案供用户审批后自动切回执行模式。
  - `memory`：管理按项目隔离的跨会话持久记忆目录（`list` / `read` / `write` / `delete`），支持嵌套子目录自动创建。

### 2.2 路径越界与符号链接防护（`src/main/tools/paths.ts`）
所有本地文件读写工具均通过 `resolveSafePath` 校验：不仅检查 `path.resolve` 后的词法路径位于工作区根目录内，还会解析父目录的 `realpath` 真实物理路径，防止通过软链接（Symlink）或目录联接（Junction）逃逸出当前项目或办公/视频沙箱。

---

## 3. 批准模式与细粒度权限规则

### 3.1 四档批准模式（`ApprovalMode`）
可在聊天输入框左下角随时切换，切换后**立即对正在运行的对话生效**：
1. `plan`（📋 规划模式）：仅开放只读工具，禁止一切写文件与命令执行。
2. `confirm`（✋ 变更前确认，默认）：所有写改文件、执行命令、MCP 外部工具调用前均弹出批准卡片。
3. `auto-edit`（🛡️ 自动编辑）：文件写改类工具（`kind === 'edit'`）自动放行，Shell 命令与外部操作仍需确认。
4. `full-access`（⚠️ 完全访问）：全部工具自动放行（切换至该模式时自动放行当前挂起的所有审批请求）。

### 3.2 `allow` / `ask` / `deny` 权限规则引擎（`src/main/permissions.ts`）
- 支持按 `ToolName(pattern)` 语法配置规则（例如 `run_command(npm test*)`、`write_file(src/**)`）。
- 匹配优先级：**`deny`（最高，直接拒绝） > `allow`（直接放行） > `ask`（强制询问） > 当前批准模式默认行为**。
- 工具卡片在等待用户批准时会自动生成建议规则（如 `run_command(git status*)`），点击「始终允许此类操作」即可一键写入 `allow` 列表。

---

## 4. MCP 客户端与子代理系统

### 4.1 MCP（Model Context Protocol）客户端（`src/main/mcp.ts`）
- **双传输协议支持**：
  - `stdio`：启动本地子进程，通过换行分隔的 JSON-RPC 2.0 通信；进程意外退出时按 5 秒退避自动重连；配置变更或禁用时立即撤销旧工具并清理进程树。
  - `Streamable HTTP`：通过 HTTP POST 发送 JSON-RPC 请求，自动维护 `mcp-session-id` 会话头，同时支持 `application/json` 单次响应与 `text/event-stream` SSE 流式响应；取消调用时主动发送 `notifications/cancelled`。
- **工具与资源映射**：已连接服务器的工具自动映射为 `mcp__<serverName>__<toolName>` 注入模型工具池，并内置 `mcp_list_resources` 与 `mcp_read_resource` 供模型浏览和读取 MCP 资源。

### 4.2 子代理系统（`src/main/subagent.ts`）
- 模型可通过 `task` 工具派生独立上下文的子代理执行专项任务（内置 `explore` 代码探索、`plan` 架构规划、`verify` 验证审查，并支持在「设置 → 子代理类型」中自定义子代理的提示词、可用工具集与最大轮次）。
- 子代理拥有独立的消息历史，不会污染主对话上下文窗口；多个子代理调用可在一个并行批次中同时运行，仅将最终结论汇总回传主代理。

---

## 5. 独立办公引擎（`src/main/office*.ts`）

无需本地安装 Microsoft Office、LibreOffice 或 Python，纯内置引擎完成四类办公文档的读写、计算与编辑：

1. **文档解析与创建（`officeDocuments.ts` & `officeWrite.ts`）**
   - 读取：支持 `.docx`（`mammoth` + XML 解析）、`.xlsx`（`exceljs`）、`.pptx`（幻灯片文本与备注提取）、`.pdf`（`pdf-parse` 文本提取）、`.txt`/`.md`/`.csv`。
   - 创建：生成标准 `.docx`（`docx` 库）、`.xlsx`、`.pptx`（`pptxgenjs`）与 `.pdf` 文件，生成后自动重解析验证结构完整性。
2. **保留原模板排版的定点编辑（`officeEditing.ts`）**
   - `office_inspect_document` 枚举原文档的段落、表格单元格、幻灯片文本框或工作表坐标。
   - `office_edit_document` 直接在 ZIP/XML 层面修改目标节点的文本或单元格内容，**100% 保留原文档的样式表、图片、页眉页脚、图表、合并单元格及未修改部件的原始字节**，并另存为新副本（拒绝修改含数字签名的文档以防破坏签名）。
3. **Excel 公式重算引擎与独立 Worker（`officeFormulas.ts` & `officeFormulaCore.ts`）**
   - 在独立 `worker_threads` 中运行，支持 `SUM`、`AVERAGE`、`IF`、`COUNTIF`、`SUMIF`、`AVERAGEIF`、`VLOOKUP`、`HLOOKUP`、`INDEX`、`ROUND`/`ROUNDUP`/`ROUNDDOWN`（基于 `BigInt` 的精确十进制 half-away 舍入）等 51 种常用函数。
   - 支持跨工作表引用、命名范围（`definedNames`）、共享公式（`shared`）坐标平移展开以及拓扑依赖图构建；自动检测循环依赖并写入 `#REF!`；对不支持的动态数组/外部引用自动清除旧缓存并标记 `#NAME?`。
4. **本地离线扫描 PDF OCR（`officeOcr.ts`）**
   - 内置 `tesseract.js` 与简中/英文离线训练数据（`resources/ocr/tessdata`），全程本机识别，不上传任何文档。
   - 自动检测 PDF 中的无文字扫描页并分批识别，返回每页识别文本与置信度评分。

---

## 6. 独立视频模式与 DAG 流水线引擎

1. **分镜配音与视频合成（`ttsEdge.ts` & `compose.ts`）**
   - `video_tts`：调用微软 Edge 在线朗读接口（免 API Key）将分镜旁白合成为 MP3 音频，支持切换音色与语速。
   - `video_compose`：首次使用时自动下载 `ffmpeg` 二进制（支持代理与国内镜像回退链），将图片/纯色背景按 1280×720 等比缩放补黑边、烧录底部字幕并对齐旁白时长合成为标准 MP4 视频。
2. **聊天驱动的 DAG 流水线引擎（`pipelineStore.ts` & `pipelineRunner.ts`）**
   - 提供 `pipeline_write`、`pipeline_run`、`pipeline_read` 三个工具，支持模型将复杂视频/多模态制作任务编排为有向无环图（DAG）节点（`script`、`tts`、`image`、`video`、`compose`）。
   - 执行器按拓扑排序逐节点运行，自动将上游节点的文本或产物路径注入下游节点，支持单节点重跑（`fromNodeId`）与「设置 → 媒体 API」配置的外部文生图/图生视频能力接入。
