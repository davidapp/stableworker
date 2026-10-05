import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_AGENTS_MD_CHARS = 20_000

/**
 * 读取项目根的 AGENTS.md（项目约定 / 技术栈说明），注入系统提示词。
 * 没有该文件、内容为空或读取失败都返回空串（不注入）。
 * 超长内容截断并注明，防止单个文件挤占过多上下文。
 */
export async function loadAgentsMd(projectPath: string): Promise<string> {
  try {
    const raw = await readFile(join(projectPath, 'AGENTS.md'), 'utf-8')
    const text = raw.trim()
    if (!text) return ''
    return text.length > MAX_AGENTS_MD_CHARS
      ? text.slice(0, MAX_AGENTS_MD_CHARS) + '\n…（AGENTS.md 过长，已截断）'
      : text
  } catch {
    return ''
  }
}
