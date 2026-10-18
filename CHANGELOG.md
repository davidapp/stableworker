# 更新日志（Changelog）

所有显著变更记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
