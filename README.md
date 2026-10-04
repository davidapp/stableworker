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
2. 右下角 **⚙ LLM 设置** —— 填协议类型 / Base URL / 模型 / API Key，点"测试连接"验证
3. 底部输入框发消息 —— 助手回复会流式打字输出；Enter 发送，Shift+Enter 换行
4. 顶部可新建 / 切换 / 删除会话；会话自动持久化，重启应用后可恢复

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
│   └── llm.ts             #   LLM 调用：OpenAI 兼容 & Anthropic 双协议，SSE 流式
├── preload/index.ts       # 桥接层：contextBridge 暴露 window.api（渲染进程唯一入口）
└── renderer/              # 界面（浏览器环境，不碰 Node）
    └── src/
        ├── store.ts       #   极简全局 store + useSyncExternalStore
        ├── actions.ts     #   全部业务动作（组件只展示、不写逻辑）
        ├── App.tsx        #   布局编排
        └── components/    #   Sidebar / ChatPane / Composer / SettingsDialog
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

**从 Claude Code 源码（参考代码）吸收的设计**

1. **单一全局配置文件**（对齐 `~/.claude.json` 模式）：内存缓存 + 全量覆盖写盘
2. **项目按规范化绝对路径做唯一键**：同目录重复添加只切换激活，不会出现两个条目
3. **API Key 安全存储分层**：Electron `safeStorage` 加密（Windows 用 DPAPI），不支持时降级为带标记明文
4. **极简自建 store**（对齐其 `state/store.ts`）：`getState/setState/subscribe` 约 20 行，接 `useSyncExternalStore`，先理解原理再考虑 Zustand
5. **消息结构向 LLM API 原生形状对齐**：将来接工具调用（tool use）时不用改数据模型

## 下一步路线（建议顺序）

1. Markdown 渲染 + 代码高亮（聊天气泡现在是纯文本 pre-wrap）
2. 会话迁移到 append-only JSONL（对齐 Claude Code，支持大文件与崩溃恢复）
3. 工具调用（Tool Use）：让代理能读文件 / 执行命令 —— 这是"AI 编程软件"的核心
4. 上下文管理：token 计量、历史裁剪、会话压缩
5. 生产 CSP（Content-Security-Policy）与 electron-builder 打包分发

## 已知简化（相对完整产品）

- 聊天上下文是纯文本拼接，未做 token 计量与裁剪
- 单条 LLM 配置（将来扩展为多 Provider 配置档 + 每项目覆盖）
- 未打包安装器（`electron-vite build` 只出可运行产物）
