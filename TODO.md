# TODO

StableWorker 的待办与想法。已完成的里程碑见 git 历史；本文件只记录**还没做**的事。
对比参考：Claude Code 源码（功能清单见下方"差距分析"）。按优先级大致排序，随时调整。

## 高优先级

- [x] **Grep / Glob 搜索工具**：内容搜索（正则 + 文件过滤，上限 150 处）与文件模式匹配（** 跨目录 / * / ?，上限 300 个）——JS 实现，忽略 node_modules/.git/二进制/大文件；回归测试 scripts/test-glob.ts
- [x] **请求韧性 withRetry**：src/main/withRetry.ts——网络错误与 429/5xx/529 指数退避（800ms×2ⁿ 封顶 12s + 抖动，最多重试 4 次），尊重 Retry-After（≤30s），4xx 与用户中止不重试；每轮请求在 chatSend 中经 attemptRound 跑在 withRetry 下（中途断流也整轮重试）；重试时发 retry 事件清空半截回复并在"思考中"位置显示进度；六场景断言验证
- [x] **AGENTS.md 加载**：项目根的 AGENTS.md（项目约定 / 技术栈说明）在每轮对话开始时读取并注入系统提示词（超 2 万字符截断；无文件 / 读取失败静默跳过）；内容可在 API 调试面板的请求体里看到；测试 tests/agentsMd.test.ts
- [x] **应用图标**：gen-icon.cjs 纯 JS 生成 1024px PNG → build/icon.png，electron-builder 自动转 ico/icns
- [ ] **代码签名与公证**：Windows 证书签名（消除 SmartScreen 提示）；macOS Developer ID 签名 + 公证（消除 Gatekeeper 提示）
- [x] **JSONL 会话文件安全**：写入失败重试一次并在界面持续告警（红条 + 重试按钮）；损坏行自动跳过 + 打开会话时显示恢复引导（黄条：恢复统计 / 在文件夹中显示 / 删除重建）；侧栏叶子 ⚠ 标记
- [x] **测试基建**：vitest 5 + v8 覆盖率（`npm run test` / `test:coverage`）；23 个用例覆盖纯逻辑层（shared 96%、contextTrim 95%、withRetry 76%）；CI 新增 check 工作流（push main / PR 时 typecheck + 覆盖率）。渲染层与依赖 Electron 的主进程模块尚未覆盖

## 中优先级

- [x] **上下文摘要压缩 + 折叠提示**：超预算时用当前模型把被裁前缀压缩成结构化摘要（保留目标 / 文件路径 / 关键决定 / 未完成事项），合并进保留部分第一条用户消息；同会话缓存复用、失败回退直接裁剪；压缩时显示"正在压缩…"状态，完成后聊天区显示"已折叠早期 N 条对话为摘要"提示条；摘要可在调试面板请求体查看；测试 tests/compact.test.ts（11 用例）
- [x] **Skill 工具**：模型可主动调用用户自定义的斜杠命令模板（未指定 name 时返回可用列表）；命令存于 userData/skills/
- [x] **Plan 规划模式**：批准模式新增 📋 规划模式——所有修改类工具从工具池移除 + 系统提示注入只读约束，模型只做研究和输出计划，用户批准后切其他模式执行
- [x] **权限规则语法**：`Tool(内容)` 三态规则（deny > ask > allow），批准卡新增"允许并不再询问"自动生成前缀规则；设置 → 权限规则页编辑；测试 tests/permissions.test.ts
- [x] **Todo 工具**：todo_write 工具 + TodoPanel 任务面板（○/◐/✓ 状态图标 + 进度计数）
- [x] **Git checkpoints**：文件检查点（不依赖 git）——write_file / edit_file 执行前把目标文件快照到 `userData/checkpoints/<项目>/<会话>/<toolUseId>/`（滚动 100 份，删除会话/项目连带清理）；工具卡片提供 ⏪ 回滚（新建文件回滚时删除；回滚前当前状态也先快照，可撤销回滚）；越界路径不快照；测试 tests/fileHistory.test.ts。"任意消息时间点选择"与 run_command 副作用覆盖为后续增强
- [x] **斜杠命令 / Skills**：userData/skills/*.md 存储 + /name args 触发展开 + Skill 工具（模型可主动调用）+ 设置页管理
- [x] **上下文管理面板**：聊天右上角"📚 上下文"弹出面板——浏览消息数/token 估算、浏览/编辑/删除摘要（追加 summary 行覆盖）、手动压缩全部对话（软清空：界面保留，请求只发摘要）、清空上下文（原 🧹 按钮并入）；后端 src/main/contextManage.ts（getInfo / saveSummary / deleteSummary / compactNow）
- [x] **多会话搜索**：全局搜索窗口（🔎，独立悬浮窗），跨项目扫描会话消息，点击结果主窗口打开
- [x] **会话导出**：导出为 Markdown（保存对话框，含角色头/时间戳/工具调用注记）
- [x] **自动更新**：electron-updater + GitHub Releases（打包版菜单"文件→检查更新…"，询问下载；yml/blockmap 元数据随 Release 上传）

## 低优先级 / 想法

- [x] **Plan mode**：批准模式新增 📋 规划模式（只读工具过滤 + 系统提示只读约束）
- [x] **MCP 工具接入**：Model Context Protocol 客户端（手写 JSON-RPC 2.0；stdio + Streamable HTTP 双传输，SSE 流式响应解析）；服务器在设置页管理（env 环境变量 / http 请求头编辑、资源浏览器、启停、重连），stdio 进程意外退出自动退避重连（5s/15s/30s→60s）；工具以 `mcp__服务器__工具` 并入工具池（默认需批准、无超时、规划模式排除）；未做：prompts、sampling、resources 分页与订阅
- [x] **子代理（task 工具）**：独立上下文的完整代理循环（src/main/subagent.ts，callRound/executeTool 依赖注入可纯逻辑测试）；general-purpose（继承工具池）与 Explore（只读）两种类型；进度实时挂到 task 工具卡片"实时输出"区，最终报告作为 tool 结果回主对话；带门禁执行器 executeToolWithGates（批准卡/权限规则/检查点）与主循环共用；轮次上限后强制收尾汇总
- [x] **子代理增强**：①只读工具并行执行（纯 kind:'read' 轮 Promise.all 并行，含写/需批准的轮次保持串行；主循环与子代理循环共用同一策略，对齐 Claude Code 的并行工具）②自定义代理类型（设置 → 子代理类型：名称/说明/工具范围/角色设定，动态注入 task 工具 subagent_type 枚举与描述，下一轮对话生效；config:setSubagentTypes 校验名称与内置冲突）③子代理内 todo_write 经 onTodos 转发主界面 Todo 面板（实现 task 工具时已通）
- [x] **子代理再增强**：并行子代理已随"并行子代理"条目完成（见微压缩条目之后）；剩余：代理类型项目级、子代理输出折叠卡片
- [x] **会话分叉**：悬停消息"🍴 从这里分叉"（最后一条也有 = 复制整个会话）——复制该消息及之前的全部内容为新会话（标题加"· 分叉"、摘要不继承、深拷贝互不影响），原会话不动并自动切换到新会话；buildForkSession 纯函数 + 测试
- [ ] **WebSearch**：需接搜索 API（Brave/Serper 等，要 API key；WebFetch 已完成）
- [ ] **run_command 增强**：ANSI 颜色渲染、命令白名单（后台长驻进程已随 task_output/task_stop 完成）
- [ ] **本地 token 估算精度**：接入真正的 tokenizer（当前为启发式估算，仅用于比例与裁剪触发）
- [ ] **流式 Markdown 增量渲染**：长回复下避免每次增量都重渲染整段
- [x] **run_command 中文输出乱码**：smartDecode（UTF-8 替换符多于 GBK 时自动改用 GBK 解码）
- [x] **上下文自动压缩（auto-compact）**：回复完成后服务端 inputTokens 超过上限 80% 且消息 ≥6 条时，自动执行与手动压缩完全相同的 compactNow 管线（渲染端触发：先等本轮落盘再压缩，零竞态；5 分钟冷却）；状态条显示"上下文已达 N%，自动压缩中…"
- [x] **斜杠命令项目级**：`<项目>/.stableworker/commands/*.md` 与全局 userData/skills 双作用域，同名项目覆盖全局（对齐 Claude Code 项目级 .claude/commands）；设置页列表带作用域标签、新建可选位置；Skill 工具与 /触发自动感知
- [x] **侧栏展开状态持久化**：项目树展开/折叠存入 config.sidebarExpanded（启动时恢复；从未记录过的项目默认展开）
- [x] **调试面板增强**：列表"加载更多"（每次 +25，默认 10 上限 500）、按模型过滤已加载记录、导出单条记录为格式化 JSON（保存对话框，密钥保持脱敏）
- [x] **Hooks 生命周期钩子（v1）**：preToolUse（exit 2 或 stdout JSON block 阻止 + 理由；approve 跳过批准门；updatedInput 改写入参）/ postToolUse（additionalContext 追加给模型）/ stop（副作用）三事件 × command 类型；stdin 收 { sessionId, toolName, toolInput, toolResult }；匹配器支持精确名与前缀通配；崩溃/超时 fail-open（日志可查）；注入点在 executeToolWithGates（主循环与子代理共用）；设置 → Hooks 页管理；未做：prompt/agent/http 类型、更多事件、Stop 阻止继续
- [x] **分层记忆（对齐 CLAUDE.md 层级模型）**：全局（userData/AGENTS.md）→ 项目父目录逐级 → 项目 AGENTS.md → 项目 AGENTS.local.md，近处优先注入；整行 @相对路径 引用（嵌套/深度≤3/环引用安全/预算受限）；设置 → 记忆页可视化管理三层；memory 工具（跨会话记忆目录 userData/memory/<项目>-<hash>/，read/write/delete/list，路径越界防护，索引 MEMORY.md）；系统提示引导模型主动记录偏好/决定/踩坑；未做：自动记忆检索召回（grep 式）、记忆跨项目共享层
- [x] **@文件引用**：输入框 @ 触发项目文件补全（递归收集、忽略 node_modules/.git/二进制，文件名前缀命中优先，≤30 条，5s 缓存）；发送时把 @路径 读为 [引用文件：…] 分节附加进消息（安全解析在项目内，单文件 20k/总预算 60k，缺失/越界标注）；↑↓/Enter/Tab/Esc 键盘导航；未做：粘贴图片输入（需多模态模型，deepseek-chat 不支持图像，待接入视觉配置）
- [x] **消息级 rewind**：悬停消息"⏪ 回到这里"——删除其后全部消息（会话文件即时落盘）；范围内有文件修改时询问是否一并按检查点逆序回放恢复到该时点（回退前当前状态先拍 restore- 快照可撤销）；planRewind 纯函数 + 测试
- [x] **microCompact**：上下文估算超上限 55%（auto-compact 0.8 之前更早介入）时，把最近 2 条助手消息之外的旧工具结果清成占位符（保留调用结构 + 100 字符预览，<200 字符的结果不动）；只作用于请求体、幂等、无模型调用；microCompact.ts 纯函数 + 6 测试
- [x] **设置分层（项目级覆盖）**：批准模式 / 工具开关 / 权限规则可按项目覆盖（config.projectOverrides，按 projectId 存）；resolveEffectiveSettings 纯函数（覆盖 > 全局；权限规则与全局合并而非替换）；chatSend 全链路消费有效值；设置 → 项目覆盖页（三态：继承全局 / 指定值）；resolveEffectiveSettings 合并语义 5 测试；未做：覆盖的导出分享（文件化）、更多设置项分层
- [x] **并行子代理**：一轮全为 task 调用时并发执行（parallelBatches 按上限 4 分批，每批 Promise.allSettled），混合轮次保持串行；每个子代理仍是完整门禁执行（钩子/批准/检查点），进度各挂独立卡片；task 描述已告知模型可并行分派；测试：会话停止/office 重负载用例加 retry 消噪，全量 274/4 skip/0 fail
- [x] **测试平台适配**：symlink 类测试探测能力不支持时跳过（Windows 需开发者模式）；shell 测试跨平台命令（node 替代 POSIX sleep/while）；killTree 双保险补杀 + taskkill 失败日志；OCR 断言路径分隔符归一——全量 267 通过 / 4 跳过 / 0 失败
- [ ] **Windows 前台命令中止的孤儿进程**：vitest worker 环境下 cmd 可能在 taskkill 启动前自行退出（报"没有找到进程"），孙进程短暂孤儿化（已加 killTree 双保险缓解）；真实应用未复现，如遇"停不下来"按此排查
- [x] **生产 CSP**：electron.vite.config.ts 的 csp-inject 插件（打包时注入 meta，dev 不注入保 HMR）
- [ ] **每项目覆盖**：工具开关 / 批准模式 / 模型允许项目级差异

## 已对齐（无需追赶）

消息模型（content blocks + 双协议回传）、JSONL 会话存储、三档批准模式、工具开关、
上下文水位条与构成明细、精确计费（分时定价 + BigInt，比参考实现的美元估算更精细）、
API 调试面板（参考实现没有的透明度）、发送前历史裁剪、多配置档、三平台 CI 与安装包。
