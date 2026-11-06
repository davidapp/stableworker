# 1.0 规划（2026-10-17 起草，2026-11-06 更新至 v0.9.7）

0.9.x 的功能面已经与 Claude Code 核心能力对齐并有多处反超（7 大原生 LLM 协议 + 39 个主流服务商预设、精确计费、API 调试透明度、独立办公模式、独立视频与 DAG 流水线模式、分层记忆 + memory 工具、消息级 rewind / 会话分叉）。1.0 的主题不是继续堆功能，而是**把"能用的开发分支"变成"敢推荐给别人用的稳定版本"**：稳定性、文档、发布质量。

## 1.0 承诺范围（做进 1.0）

1. **稳定性与验收**
   - 三平台安装包端到端真机验收：安装、首启、旧版（0.9.x）→ 最新版升级、项目/会话/设置数据保留、卸载残留
     （沿用 [releasing.md](./releasing.md) 的设备验收清单，逐项勾掉）
   - 长会话压力场景：50 轮工具循环、上下文触发 micro/摘要/auto-compact 三级压缩、并行子代理 ×4
   - 崩溃与错误路径：断网 / API 429 / 402 余额不足容错 / 会话文件损坏恢复 / 更新中断
2. **文档（已完成）**
   - [x] README 面向最终用户与开发者更新
   - [x] [CHANGELOG.md](../CHANGELOG.md) 建立并持续维护（0.9.0 ~ 0.9.7）
   - [x] `docs/` 技术文档体系建立：[README.md](./README.md)、[DESIGN.md](./DESIGN.md)、[llm-providers.md](./llm-providers.md)、[tools-and-modes.md](./tools-and-modes.md)、[releasing.md](./releasing.md) 各司其职
3. **发布质量**
   - Windows 代码签名（需要证书；未签名则 1.0 发布说明明确披露 SmartScreen 提示）
   - macOS 决策：购买 Apple Developer 走签名+公证，或 1.0 明确"仅 Windows/Linux"
   - 自动更新端到端验证（0.9.x → 1.0 至少覆盖 Windows 真机一次）
4. **已排期的功能收尾（已于 0.9.5 ~ 0.9.7 全部完成）**
   - [x] ~~设置分层（项目级覆盖）~~：已实现后按用户决定于 0.9.5 移除（功能与页面一并删除）
   - [x] Skills frontmatter：`allowed-tools` / `model` 声明、模板内嵌命令 `!`
   - [x] `microCompact` 阈值与保留窗口的可调化（设置页暴露）
   - [x] 视频模式与聊天驱动的 DAG 流水线引擎（`pipeline_write` / `pipeline_run` / `pipeline_read` + 媒体 API 配置）
   - [x] 7 种大模型原生 API 协议（`openai-compatible` / `openai-responses` / `anthropic` / `gemini` / `azure-openai` / `ollama` / `cohere`）与 39 个主流服务商预设

## 1.0 验收标准（全部满足才打 1.0 标签）

- [x] 全量测试通过（当前 Windows 本机 40 个测试文件：322 通过 / 4 跳过 / 0 失败）
- [ ] 设备验收清单（[releasing.md](./releasing.md)）三平台全部勾完，证据（截图/日志）归档
- [ ] 0.9.x → 1.0 升级在 Windows 真机走通：检查更新 → 下载 → 安装 → 数据保留
- [x] 用户与技术文档：README 上手路径清晰；CHANGELOG 与 `docs/` 技术文档完整
- [ ] 已知局限清单发布（Windows 孤儿进程、未签名提示、macOS 平台策略），无未披露缺陷

## 1.0 非目标

- 协作、云同步、移动端
- MCP OAuth / prompts / sampling（0.10+ 备选）

## 里程碑进度

| 版本 | 内容 | 状态 |
| --- | --- | --- |
| 0.9.5 | Skills frontmatter + 会话独立模型 + WebSearch + MCP 资源工具 | ✅ 已发布 |
| 0.9.6 | `microCompact` 可调化 + 视频模式与流水线引擎 + 余额不足容错 | ✅ 已发布 |
| 0.9.7 | 7 大原生 LLM 协议 + 39 个服务商预设 + 全库代码审查修复 + `docs/` 技术文档体系 | ✅ 已发布 |
| 1.0 | 真机验收矩阵全部通过后打标 | 进行中 |
