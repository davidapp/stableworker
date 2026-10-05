import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { safeResolve, truncateText } from './paths'
import type { ToolContext } from './index'

/**
 * 搜索类工具：Grep（内容搜索）与 Glob（文件名模式匹配）。
 * 纯 JS 实现（无 ripgrep 依赖）：递归遍历 + 逐文件匹配，适合中小项目；
 * 内置忽略目录、二进制扩展名、大文件跳过与结果数量上限，防止失控。
 */

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '__pycache__',
  'venv',
  '.venv',
])

const BINARY_EXT =
  /\.(png|jpe?g|gif|bmp|webp|ico|icns|woff2?|ttf|otf|eot|exe|dll|so|dylib|zip|gz|tar|7z|rar|pdf|mp[34]|avi|mov|mkv|sqlite3?|db|class|jar|wasm|node)$/i

const MAX_FILE_BYTES = 1_500_000
const MAX_FILES_SCANNED = 5000
const MAX_GREP_MATCHES = 150
const MAX_GLOB_RESULTS = 300

/** 递归收集文本文件（忽略目录 / 二进制扩展名 / 大文件），返回绝对路径列表 */
async function walkFiles(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES_SCANNED) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (out.length >= MAX_FILES_SCANNED) return
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue
      await walkFiles(full, out)
    } else if (e.isFile()) {
      if (BINARY_EXT.test(e.name)) continue
      const st = await stat(full).catch(() => null)
      if (st && st.size <= MAX_FILE_BYTES) out.push(full)
    }
  }
}

/** 极简 glob → RegExp：支持 **（跨段）、*（段内）、?（单字符），其余按字面量 */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++ // "**/" 也吞掉后面的斜杠
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

async function collectTextFiles(
  projectPath: string,
  path: unknown,
): Promise<{ files: string[]; root: string } | { error: string }> {
  try {
    const root = safeResolve(projectPath, typeof path === 'string' && path ? path : '.')
    const files: string[] = []
    await walkFiles(root, files)
    return { files, root }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- Grep：内容搜索 ----------

export const grepTool = {
  name: 'grep',
  description:
    '在项目内按正则表达式搜索文件内容（等价于简化版 grep -rn）。返回"文件:行号: 内容"列表。找代码、找报错文本、找定义时用它；按文件名找文件用 glob。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式（JS 语法）' },
      path: { type: 'string', description: '搜索起始目录（项目内相对路径，默认项目根）' },
      include: { type: 'string', description: '文件过滤 glob，如 "*.ts" 或 "src/**"' },
      caseInsensitive: { type: 'boolean', description: '是否忽略大小写，默认区分' },
    },
    required: ['pattern'],
  },
  kind: 'read' as const,
  timeoutMs: 30_000,
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern) return { content: '缺少 pattern 参数', isError: true }
    let re: RegExp
    try {
      re = new RegExp(pattern, input.caseInsensitive === true ? 'giu' : 'gu')
    } catch (e) {
      return { content: `正则表达式无效：${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
    const includeRe = typeof input.include === 'string' && input.include ? globToRegExp(input.include) : null

    const collected = await collectTextFiles(ctx.projectPath, input.path)
    if ('error' in collected) return { content: collected.error, isError: true }
    const { files, root } = collected

    const outLines: string[] = []
    let matchCount = 0
    let fileCount = 0
    let truncated = false
    for (const file of files) {
      if (matchCount >= MAX_GREP_MATCHES) {
        truncated = true
        break
      }
      const rel = relative(root, file).split('\\').join('/')
      if (includeRe && !includeRe.test(rel)) continue
      let raw: string
      try {
        raw = await readFile(file, 'utf-8')
      } catch {
        continue
      }
      let fileHasMatch = false
      const lines = raw.split('\n')
      for (let i = 0; i < lines.length && matchCount < MAX_GREP_MATCHES; i++) {
        re.lastIndex = 0
        if (!re.test(lines[i])) continue
        matchCount++
        fileHasMatch = true
        outLines.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`)
      }
      if (fileHasMatch) fileCount++
    }

    if (matchCount === 0) return { content: `未找到匹配（pattern: ${pattern}，扫描 ${files.length} 个文件）` }
    return {
      content: truncateText(
        `共 ${matchCount} 处匹配（${fileCount} 个文件，扫描 ${files.length} 个文件）${truncated ? '，结果已截断' : ''}\n${outLines.join('\n')}`,
      ),
    }
  },
}

// ---------- Glob：文件名模式匹配 ----------

export const globTool = {
  name: 'glob',
  description:
    '按 glob 模式列出项目内匹配的文件路径（支持 ** 跨目录、* 段内通配、? 单字符），如 "src/**/*.ts"、"*.md"。按文件名找文件用它；找文件内容用 grep。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 "src/**/*.ts"、"*.md"' },
      path: { type: 'string', description: '匹配起始目录（项目内相对路径，默认项目根）' },
    },
    required: ['pattern'],
  },
  kind: 'read' as const,
  timeoutMs: 30_000,
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern) return { content: '缺少 pattern 参数', isError: true }
    const re = globToRegExp(pattern)

    const collected = await collectTextFiles(ctx.projectPath, input.path)
    if ('error' in collected) return { content: collected.error, isError: true }
    const { files, root } = collected

    const matches: string[] = []
    for (const file of files) {
      const rel = relative(root, file).split('\\').join('/')
      // 不含 "/" 的模式匹配文件名（如 "*.md"）；含 "/" 的匹配相对路径
      const hit = pattern.includes('/') ? re.test(rel) : re.test(rel.split('/').pop() ?? '')
      if (hit) {
        matches.push(rel)
        if (matches.length >= MAX_GLOB_RESULTS) break
      }
    }

    if (matches.length === 0) return { content: `未找到匹配（pattern: ${pattern}，扫描 ${files.length} 个文件）` }
    return {
      content: truncateText(
        `共 ${matches.length} 个文件${matches.length >= MAX_GLOB_RESULTS ? '（已截断）' : ''}\n${matches.join('\n')}`,
      ),
    }
  },
}
