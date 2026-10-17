/**
 * 界面 i18n（v1）：以中文原文为键，EN 词典提供英文翻译，缺失时回退中文原文。
 * setLanguage 在 applyConfig 时调用；组件通过 useApp() 订阅 store 变化后重渲染，
 * t() 读取模块级当前语言即可获得正确翻译。
 * 覆盖范围：核心框架 + 主要可见面（侧栏 / 输入框 / 聊天区 / 批准与思考菜单 / 上下文弹层 /
 * 办公面板 / 设置导航）；各设置页内部文案逐步迁移。
 */

export type Language = 'zh' | 'en'

let current: Language = 'zh'

const EN: [string, string][] = [
  // 侧栏
  ['编程', 'Code'],
  ['办公', 'Office'],
  ['＋ 新建项目', '＋ New Project'],
  ['新建办公任务', 'New Office Task'],
  ['办公任务', 'Office Tasks'],
  ['新建任务，开始整理资料', 'New task — add materials to begin'],
  ['工作区', 'Workspaces'],
  ['还没有工作区', 'No workspaces yet'],
  ['添加本地目录，开始协作', 'Add a local directory to get started'],
  ['设置', 'Settings'],
  ['搜索所有会话', 'Search all sessions'],
  ['API 调试（Ctrl+Alt+D）', 'API Inspector (Ctrl+Alt+D)'],
  ['界面', 'Appearance'],
  ['界面语言', 'Language'],
  ['主题', 'Theme'],
  ['暗黑', 'Dark'],
  ['明亮', 'Light'],
  ['重命名', 'Rename'],
  ['删除', 'Delete'],
  // 输入框
  ['输入消息，@ 引用项目文件，Enter 发送，Shift+Enter 换行', 'Type a message, @ to reference files, Enter to send, Shift+Enter for newline'],
  ['描述要完成的工作，或添加资料开始', 'Describe the task or add materials to begin'],
  ['添加办公资料', 'Add materials'],
  ['停止生成', 'Stop generating'],
  ['请阅读这些资料，并整理主要内容。', 'Please read these materials and summarize the key points.'],
  // 聊天区
  ['思考中…', 'Thinking…'],
  ['思考过程', 'Reasoning'],
  ['滚到最下面', 'Scroll to bottom'],
  ['回到这里', 'Rewind here'],
  ['从这里分叉', 'Fork from here'],
  ['介绍这个项目的结构', "Walk me through this project's structure"],
  ['检查代码中潜在的问题', 'Check the code for potential issues'],
  ['帮我规划下一步开发', 'Help me plan the next steps'],
  ['生成一份 Word 项目周报模板', 'Create a Word weekly report template'],
  ['制作一个 Excel 费用汇总表', 'Build an Excel expense summary sheet'],
  ['制作一份三页 PPT 工作总结', 'Make a 3-page PPT work summary'],
  ['提问、排查问题或描述一个想法，助手会结合项目文件与你协作。', 'Ask questions, debug, or describe an idea — the assistant works with your project files.'],
  ['整理文档、分析表格、制作演示文稿。添加资料或直接描述任务，生成可打开的办公文件。', 'Organize documents, analyze spreadsheets, build decks. Add materials or describe the task to generate real office files.'],
  ['上下文', 'Context'],
  ['新会话', 'New Session'],
  ['你的 AI 办公助手', 'Your AI office assistant'],
  ['把资料变成工作成果', 'Turn materials into deliverables'],
  ['今天一起完成什么？', 'What shall we get done today?'],
  // 办公面板
  ['任务文件', 'Task Files'],
  ['添加资料', 'Add materials'],
  ['参考资料', 'Reference materials'],
  ['生成结果', 'Generated results'],
  ['导入资料，预览并打开生成的文件。', 'Import materials; preview and open generated files.'],
  ['支持 Word、Excel、PPT、PDF 和文本', 'Supports Word, Excel, PPT, PDF and text'],
  ['完成后，文件会出现在这里', 'Completed files will appear here'],
  ['展开任务文件面板', 'Expand task files panel'],
  ['收起任务文件面板', 'Collapse task files panel'],
  // 批准模式 / 思考力度
  ['规划模式', 'Plan mode'],
  ['变更前确认', 'Confirm edits'],
  ['自动编辑', 'Auto-edit'],
  ['完全访问', 'Full access'],
  ['只读研究和制定计划。', 'Read-only research and planning.'],
  ['改文件前先问我。', 'Asks before changing files.'],
  ['自动编辑文件。', 'Edits files automatically.'],
  ['减少确认次数。', 'Fewer confirmations.'],
  ['低', 'Low'],
  ['中', 'Medium'],
  ['高', 'High'],
  ['思考力度（推理模型）', 'Thinking effort (reasoning models)'],
  // 上下文弹层
  ['已用', 'Used'],
  ['消息', 'Messages'],
  ['系统工具', 'Tools'],
  ['系统提示词', 'System prompt'],
  ['输出（最近一轮）', 'Output (last round)'],
  ['输出上限', 'Output limit'],
  ['缓存命中率', 'Cache hit rate'],
  ['上下文容量', 'Context capacity'],
  ['当前会话输入用量', 'Session input usage'],
  // 设置导航
  ['LLM 配置', 'LLM Profiles'],
  ['模型价格', 'Model Pricing'],
  ['工具开关', 'Tool Switches'],
  ['权限规则', 'Permission Rules'],
  ['斜杠命令', 'Slash Commands'],
  ['MCP 服务器', 'MCP Servers'],
  ['子代理类型', 'Subagent Types'],
  ['Hooks', 'Hooks'],
  ['记忆', 'Memory'],
  ['项目覆盖', 'Project Overrides'],
  ['功能开关', 'Features'],
  ['关闭', 'Close'],
  ['最小化', 'Minimize'],
  ['最大化', 'Maximize'],
  ['偏好设置', 'Preferences'],
]

export function setLanguage(lang: Language): void {
  current = lang
}

/** 翻译：以中文原文为键；英文缺失或当前为中文时原样返回 */
export function t(s: string): string {
  if (current === 'zh') return s
  const hit = EN.find(([k]) => k === s)
  return hit ? hit[1] : s
}
