import { createHash } from 'node:crypto'
import { readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'
import type { ToolDefinition } from './tools/index'

/**
 * memory 工具：按项目隔离的跨会话记忆目录（userData/memory/<项目>-<hash>/）。
 * 模型用它记录/查询持久信息（用户偏好、项目决定、踩坑记录），索引固定为 MEMORY.md。
 * 路径限制在记忆目录内（拒绝 .. 与绝对路径）；写操作不设批准门（目录在用户数据区，低风险）。
 */

const INDEX_FILE = 'MEMORY.md'

/** 记忆根目录（测试可用 SW_MEMORY_TEST_ROOT 覆盖） */
function memoryRoot(): string {
  return process.env.SW_MEMORY_TEST_ROOT ?? join(app.getPath('userData'), 'memory')
}

export function memoryDirFor(projectPath: string | null): string {
  if (!projectPath) return join(memoryRoot(), 'default')
  const name = basename(projectPath).replace(/[^\w.-]+/g, '_').slice(0, 32) || 'project'
  const hash = createHash('sha1').update(resolve(projectPath).toLowerCase()).digest('hex').slice(0, 8)
  return join(memoryRoot(), `${name}-${hash}`)
}

function isAbsoluteLike(p: string): boolean {
  if (isAbsolute(p)) return true
  return p.split(/[\\/]/).includes('..')
}

/** 解析记忆目录内的相对路径，越界/非法返回 null */
function safeResolvePath(dir: string, relPath: string | undefined): string | null {
  const rel = (relPath ?? '').trim() || INDEX_FILE
  if (isAbsoluteLike(rel)) return null
  const target = resolve(dir, rel)
  const root = resolve(dir)
  if (target !== root && !target.startsWith(root + '\\') && !target.startsWith(root + '/')) return null
  return target
}

export const memoryTool: ToolDefinition = {
  name: 'memory',
  description:
    '读写跨会话的长期记忆目录（按项目隔离，位于用户数据区，不进项目仓库）。' +
    '用于：记录用户偏好与约定、重要决定及原因、踩坑与解决方案、长期任务进度。' +
    'action=list 列出全部记忆文件；action=read（默认 MEMORY.md 索引）读取；' +
    'action=write 覆盖写入（需 content，索引建议一行一条 `- [标题](文件.md) — 摘要`）；' +
    'action=delete 删除文件。开始新任务前建议先 read 索引。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'delete', 'list'], description: '操作类型' },
      path: { type: 'string', description: '记忆目录内相对路径（默认 MEMORY.md），如 preferences.md' },
      content: { type: 'string', description: 'write 时的完整文件内容' },
    },
    required: ['action'],
  },
  timeoutMs: 10_000,
  async execute(input: Record<string, unknown>, ctx) {
    const action = String(input.action ?? '')
    const dir = memoryDirFor(ctx.projectPath ?? null)
    const rel = (typeof input.path === 'string' ? input.path : '').trim() || INDEX_FILE
    const path = safeResolvePath(dir, rel)
    if (!path) return { content: '非法路径：只允许记忆目录内的相对路径（禁止 .. 与绝对路径）', isError: true }
    try {
      if (action === 'list') {
        await mkdir(dir, { recursive: true })
        const files = (await readdir(dir)).filter((f) => !f.startsWith('.'))
        return { content: files.length > 0 ? files.join('\n') : '（记忆目录为空）' }
      }
      if (action === 'read') {
        const text = await readFile(path, 'utf-8').catch(() => null)
        return { content: text ?? '（文件不存在或为空；可用 action=write 创建）' }
      }
      if (action === 'write') {
        const content = typeof input.content === 'string' ? input.content : ''
        if (!content.trim()) return { content: 'write 需要 content 参数', isError: true }
        await mkdir(dir, { recursive: true })
        await writeFile(path, content, 'utf-8')
        return { content: `已写入记忆：${rel}` }
      }
      if (action === 'delete') {
        await rm(path, { force: true })
        return { content: `已删除记忆：${rel}` }
      }
      return { content: `未知 action：${action}`, isError: true }
    } catch (e) {
      return { content: `memory 操作失败：${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
}
