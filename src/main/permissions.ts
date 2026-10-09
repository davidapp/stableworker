import type { PermissionRules } from '../shared/types'

/**
 * 权限规则语法（对齐 Claude Code 的 Tool(content) 形式）：
 *   run_command                     → 匹配该工具的任何调用
 *   run_command(npm test)           → 精确匹配（command === "npm test"）
 *   run_command(npm *)              → 前缀匹配（command 以 "npm " 开头）
 *   edit_file(src/*)                → 路径前缀匹配（支持目录前缀）
 *
 * 优先级：deny > allow > ask；未命中返回 null（交给批准模式决定）。
 */

export interface ParsedRule {
  tool: string
  content: string | null
}

export type RuleVerdict = 'allow' | 'ask' | 'deny'

export function parseRule(rule: string): ParsedRule | null {
  const t = rule.trim()
  if (!t) return null
  const i = t.indexOf('(')
  if (i < 0) return { tool: t, content: null }
  const content = t.slice(i + 1, t.endsWith(')') ? t.length - 1 : t.length)
  return { tool: t.slice(0, i), content: content || null }
}

/** 工具调用中被规则匹配的"内容"：路径类取 path，命令类取 command */
export function ruleContentFor(tool: string, input: Record<string, unknown>): string {
  const v = (input as Record<string, unknown>)[tool === 'run_command' ? 'command' : 'path'] ?? input.pattern ?? ''
  return typeof v === 'string' ? v : JSON.stringify(v ?? '')
}

export function ruleMatches(rule: string, tool: string, input: Record<string, unknown>): boolean {
  const p = parseRule(rule)
  if (!p || p.tool !== tool) return false
  if (p.content == null) return true
  const actual = ruleContentFor(tool, input)
  if (p.content.endsWith(':*')) return actual.startsWith(p.content.slice(0, -2))
  if (p.content.endsWith('*')) return actual.startsWith(p.content.slice(0, -1))
  return actual === p.content
}

export function evaluateRules(
  rules: PermissionRules | undefined,
  tool: string,
  input: Record<string, unknown>,
): RuleVerdict | null {
  const list = rules ?? { allow: [], ask: [], deny: [] }
  if (list.deny?.some((r) => ruleMatches(r, tool, input))) return 'deny'
  if (list.allow?.some((r) => ruleMatches(r, tool, input))) return 'allow'
  if (list.ask?.some((r) => ruleMatches(r, tool, input))) return 'ask'
  return null
}

/** 根据一次实际调用生成建议规则（"允许并不再询问"用） */
export function suggestRule(tool: string, input: Record<string, unknown>): string {
  const content = ruleContentFor(tool, input)
  if (tool === 'run_command') {
    const parts = content.trim().split(/\s+/).filter(Boolean)
    return parts.length > 1 ? `${tool}(${parts.slice(0, 2).join(' ')} *)` : `${tool}(${content} *)`
  }
  const dir = content.includes('/') ? content.slice(0, content.lastIndexOf('/') + 1) : ''
  return `${tool}(${dir}*)`
}
