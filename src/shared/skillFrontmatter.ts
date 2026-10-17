/**
 * Skill 斜杠命令的 frontmatter（对齐 Claude Code commands 元数据）：
 *   ---
 *   description: 一句话说明（Skill 工具列表展示）
 *   allowed-tools: read_file, grep   （逗号分隔；触发该命令的对话轮只可用这些工具）
 *   model: deepseek-pro              （按模型名匹配配置档，覆盖当前激活档）
 *   ---
 * 纯函数：渲染层（列表展示）与主进程（展开执行）共用，无 Node/Electron 依赖。
 */

export interface SkillFrontmatter {
  description?: string
  allowedTools?: string[]
  model?: string
}

export interface ParsedSkill {
  meta: SkillFrontmatter
  /** 去掉 frontmatter 后的模板正文 */
  body: string
}

export function parseSkillFrontmatter(raw: string): ParsedSkill {
  const text = raw.replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: SkillFrontmatter = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (!value) continue
    if (key === 'description') meta.description = value
    else if (key === 'allowed-tools' || key === 'allowed_tools')
      meta.allowedTools = value.split(',').map((x) => x.trim()).filter(Boolean)
    else if (key === 'model') meta.model = value
  }
  return { meta, body: text.slice(m[0].length) }
}

/**
 * 展开模板参数（$ARGUMENTS 全量 / $1 $2 位置参数）。
 * 与主进程 loadSkillContent 共用，保证斜杠触发与 Skill 工具行为一致。
 */
export function substituteArgs(body: string, args: string): string {
  const positional = args ? args.split(/\s+/) : []
  return body.replaceAll('$ARGUMENTS', args).replaceAll(/\$(\d+)/g, (_, n: string) => positional[Number(n) - 1] ?? '')
}
