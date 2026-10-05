import { resolve, sep } from 'node:path'

/** 输出截断上限（工具结果统一 2 万字符） */
export const MAX_OUTPUT_CHARS = 20_000

/** 把项目内相对路径解析为绝对路径；越出项目目录立即抛错 */
export function safeResolve(projectPath: string, relative: string): string {
  const root = resolve(projectPath)
  const target = resolve(root, relative || '.')
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`路径越界：${relative} 不在项目目录内`)
  }
  return target
}

/** 工具结果统一截断 */
export function truncateText(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length > max ? text.slice(0, max) + `\n…（结果过长，已截断到 ${max} 字符）` : text
}
