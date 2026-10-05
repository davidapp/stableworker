# TODO

StableWorker 的待办与想法。已完成的里程碑见 git 历史；本文件只记录**还没做**的事。
对比参考：Claude Code 源码（功能清单见下方"差距分析"）。按优先级大致排序，随时调整。

## 高优先级

- [x] **Grep / Glob 搜索工具**：内容搜索（正则 + 文件过滤，上限 150 处）与文件模式匹配（** 跨目录 / * / ?，上限 300 个）——JS 实现，忽略 node_modules/.git/二进制/大文件；回归测试 scripts/test-glob.ts
- [x] **请求韧性 withRetry**：src/main/withRetry.ts——网络错误与 429/5xx/529 指数退避（800ms×2ⁿ 封顶 12s + 抖动，最多重试 4 次），尊重 Retry-After（≤30s），4xx 与用户中止不重试；每轮请求在 chatSend 中经 attemptRound 跑在 withRetry 下（中途断流也整轮重试）；重试时发 retry 事件清空半截回复并在"思考中"位置显示进度；六场景断言验证
- [x] **AGENTS.md 加载**：项目根的 AGENTS.md（项目约定 / 技术栈说明）在每轮对话开始时读取并注入系统提示词（超 2 万字符截断；无文件 / 读取失败静默跳过）；内容可在 API 调试面板的请求体里看到；测试 tests/agentsMd.test.ts
- [ ] **应用图标**：设计 / 制作 Windows `.ico` 与 macOS `.icns`，配置进 electron-builder
- [ ] **代码签名与公证**：Windows 证书签名（消除 SmartScreen 提示）；macOS Developer ID 签名 + 公证（消除 Gatekeeper 提示）
- [x] **JSONL 会话文件安全**：写入失败重试一次并在界面持续告警（红条 + 重试按钮）；损坏行自动跳过 + 打开会话时显示恢复引导（黄条：恢复统计 / 在文件夹中显示 / 删除重建）；侧栏叶子 ⚠ 标记
- [x] **测试基建**：vitest 5 + v8 覆盖率（`npm run test` / `test:coverage`）；23 个用例覆盖纯逻辑层（shared 96%、contextTrim 95%、withRetry 76%）；CI 新增 check 工作流（push main / PR 时 typecheck + 覆盖率）。渲染层与依赖 Electron 的主进程模块尚未覆盖

## 中优先级

- [x] **上下文摘要压缩 + 折叠提示**：超预算时用当前模型把被裁前缀压缩成结构化摘要（保留目标 / 文件路径 / 关键决定 / 未完成事项），合并进保留部分第一条用户消息；同会话缓存复用、失败回退直接裁剪；压缩时显示"正在压缩…"状态，完成后聊天区显示"已折叠早期 N 条对话为摘要"提示条；摘要可在调试面板请求体查看；测试 tests/compact.test.ts（11 用例）
- [ ] **权限规则语法**：`Tool(内容前缀)` 形式的允许 / 拒绝 / 询问规则（如 `run_command(npm:*)`），"不再询问"持久化；与三档批准模式叠加
- [ ] **Todo 工具**：模型对复杂任务自主列任务清单、勾进度，聊天侧渲染任务面板
- [x] **Git checkpoints**：文件检查点（不依赖 git）——write_file / edit_file 执行前把目标文件快照到 `userData/checkpoints/<项目>/<会话>/<toolUseId>/`（滚动 100 份，删除会话/项目连带清理）；工具卡片提供 ⏪ 回滚（新建文件回滚时删除；回滚前当前状态也先快照，可撤销回滚）；越界路径不快照；测试 tests/fileHistory.test.ts。"任意消息时间点选择"与 run_command 副作用覆盖为后续增强
- [ ] **斜杠命令 / Skills**：自定义 prompt 模板（markdown + 参数替换）
- [x] **上下文管理面板**：聊天右上角"📚 上下文"弹出面板——浏览消息数/token 估算、浏览/编辑/删除摘要（追加 summary 行覆盖）、手动压缩全部对话（软清空：界面保留，请求只发摘要）、清空上下文（原 🧹 按钮并入）；后端 src/main/contextManage.ts（getInfo / saveSummary / deleteSummary / compactNow）
- [ ] **多会话搜索**：跨会话搜索消息内容（JSONL 逐文件扫描即可起步）
- [ ] **会话导出**：导出为 Markdown / JSON，方便归档与分享
- [ ] **自动更新**：electron-updater + GitHub Releases（三平台工作流已就绪，缺更新源与差量）

## 低优先级 / 想法

- [ ] **Plan mode**：先只读规划、批准后再执行的第四种批准模式
- [ ] **MCP 工具接入**：通过 Model Context Protocol 动态接入外部工具服务器（stdio / http 传输起步）
- [ ] **子代理（Task 工具）**：上下文隔离的子任务 + 结果回传（复杂度高，依赖多轮循环成熟度）
- [ ] **Web 工具**：WebFetch（拉 URL 转 markdown，注意 SSRF 防护）/ WebSearch（需接搜索 API）
- [ ] **run_command 增强**：后台长驻进程（dev server 等）、ANSI 颜色渲染、命令白名单
- [ ] **本地 token 估算精度**：接入真正的 tokenizer（当前为启发式估算，仅用于比例与裁剪触发）
- [ ] **流式 Markdown 增量渲染**：长回复下避免每次增量都重渲染整段
- [ ] **run_command 中文输出乱码**：Windows cmd 的 GBK 代码页问题（检测 chcp / 转码）
- [ ] **侧栏展开状态持久化**：项目树的展开 / 折叠状态存入配置
- [ ] **调试面板增强**：历史记录"加载更多"、按会话 / 按模型过滤、导出单条记录
- [ ] **生产 CSP**：Content-Security-Policy 收紧渲染进程的网络与脚本来源
- [ ] **每项目覆盖**：工具开关 / 批准模式 / 模型允许项目级差异

## 已对齐（无需追赶）

消息模型（content blocks + 双协议回传）、JSONL 会话存储、三档批准模式、工具开关、
上下文水位条与构成明细、精确计费（分时定价 + BigInt，比参考实现的美元估算更精细）、
API 调试面板（参考实现没有的透明度）、发送前历史裁剪、多配置档、三平台 CI 与安装包。
