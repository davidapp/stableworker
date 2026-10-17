/**
 * 界面 i18n（v1）：以中文原文为键，EN 词典提供英文翻译，缺失时回退中文原文。
 * setLanguage 在 applyConfig 时调用；组件通过 useApp() 订阅 store 变化后重渲染，
 * t() 读取模块级当前语言即可获得正确翻译。
 * 覆盖范围：核心框架（侧栏 / 输入框 / 聊天区 / 设置导航）；各设置页内部文案逐步迁移。
 */

export type Language = 'zh' | 'en'

let current: Language = 'zh'

const EN = new Map<string, string>([
  // 侧栏
  ['编程', 'Code'],
  ['办公', 'Office'],
  ['＋ 新建项目', '＋ New Project'],
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
  ['结合项目文件与你协作', 'Works with your project files'],
  ['资料仅导入当前任务 · 生成结果可预览和打开', 'Materials are imported into this task · results can be previewed and opened'],
  ['Enter 发送 · Shift + Enter 换行', 'Enter to send · Shift + Enter for newline'],
  ['添加办公资料', 'Add materials'],
  ['停止生成', 'Stop generating'],
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
  // 设置导航
  ['设置', 'Settings'],
])

export function setLanguage(lang: Language): void {
  current = lang
}

/** 翻译：以中文原文为键；英文缺失或当前为中文时原样返回 */
export function t(s: string): string {
  if (current === 'zh') return s
  return EN.get(s) ?? s
}
