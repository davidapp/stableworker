# StableWorker 技术文档目录

本目录收录 StableWorker（当前版本 **v0.9.7**）的系统架构设计、大模型协议规范、工具与多模式引擎实现以及发布质量文档。

## 文档索引

| 文档 | 说明 |
| :--- | :--- |
| [DESIGN.md](./DESIGN.md) | **系统架构与核心技术设计**：Electron 三进程模型、IPC 通信矩阵、Agent Loop 代理循环、三级上下文压缩、Append-only JSONL 事务存储与 CAS 乐观锁、文件检查点回滚、精确计费引擎与 API 调试器 |
| [llm-providers.md](./llm-providers.md) | **大模型 API 协议与服务商接入规范**：7 种原生 API 协议（`openai-compatible`、`openai-responses`、`anthropic`、`gemini`、`azure-openai`、`ollama`、`cohere`）报文映射、SSE/NDJSON 流式解析、39 个内置服务商预设、模型容量自动探测、模型列表拉取与多平台余额查询 |
| [tools-and-modes.md](./tools-and-modes.md) | **工具系统、MCP、子代理与办公/视频引擎**：工具注册与安全沙箱、批准模式与权限规则、MCP 客户端（`stdio` / `Streamable HTTP`）、子代理并发调度、Skills 与分层记忆、独立办公引擎（保留模板编辑 / 公式计算 Worker / 本地 OCR）与独立视频流水线引擎（DAG Pipeline / Edge-TTS / FFmpeg） |
| [releasing.md](./releasing.md) | **发布质量、代码签名与自动更新规范**：三平台打包策略、`verify-release-assets.mjs` 产物完整性校验、自动更新版本判定与真机验收清单 |
| [PLAN-1.0.md](./PLAN-1.0.md) | **1.0 版本里程碑与验收标准**：从 0.9.x 到 1.0 正式版的功能收尾、稳定性压测与真机验收计划 |

## 许可证与设计资源

- `docs/design/`：界面预览图与 Linear 图标许可说明（`linear-LICENSE`）
- `docs/licenses/`：第三方核心算法库许可证（`fast-formula-parser-LICENSE`）
