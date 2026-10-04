import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { ipcMain } from 'electron'
import type { ToolUseBlock } from '../../shared/types'

/**
 * 工具注册中心（借鉴 Claude Code 的 tools.ts 模式）：
 * 每个工具 = 名称 + 描述 + JSON Schema + 执行函数，集中注册、按需扩展。
 *
 * 安全约定：
 * - 工具只在主进程执行，渲染进程没有任何调用通道（模型请求 → 主进程执行 → 结果回传）
 * - 所有文件路径用 safeResolve 限制在项目目录内，越界直接报错
 * - 执行有超时，结果有长度上限，异常一律转成 isError 结果喂回模型
 */

export interface ToolContext {
  /** 激活项目的绝对路径，工具只能在这个目录内活动 */
  projectPath: string
}

export interface ToolOutput {
  content: string
  isError?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema（Anthropic 直接用作 input_schema，OpenAI 包在 parameters 里） */
  inputSchema: Record<string, unknown>
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>
  /** true = 有副作用的危险操作（如写文件），执行前必须经用户在界面上批准（除非批准模式放行） */
  requiresApproval?: boolean
  /**
   * 危险类别：edit = 文件编辑（"自动编辑"模式放行）；system = 执行命令等更高风险操作；
   * 只读工具可省略
   */
  kind?: 'read' | 'edit' | 'system'
  /** 工具执行超时（毫秒）；不设用全局默认 15 秒 */
  timeoutMs?: number
}

const MAX_LIST_ENTRIES = 300
const MAX_READ_LINES = 2000
const MAX_OUTPUT_CHARS = 20_000
const MAX_WRITE_CHARS = 500_000
const TOOL_TIMEOUT_MS = 15_000

/** 把项目内相对路径解析为绝对路径；越出项目目录立即抛错 */
function safeResolve(projectPath: string, relative: string): string {
  const root = resolve(projectPath)
  const target = resolve(root, relative || '.')
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`路径越界：${relative} 不在项目目录内`)
  }
  return target
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? text.slice(0, MAX_OUTPUT_CHARS) + `\n…（结果过长，已截断到 ${MAX_OUTPUT_CHARS} 字符）`
    : text
}

const listFiles: ToolDefinition = {
  name: 'list_files',
  description: '列出项目内某个目录下的文件和子目录（不递归）。path 省略时列出项目根目录。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '项目内相对路径，默认为根目录' },
    },
    required: [],
  },
  async execute(input, ctx) {
    const dir = safeResolve(ctx.projectPath, typeof input.path === 'string' ? input.path : '.')
    const entries = await readdir(dir, { withFileTypes: true })
    if (entries.length === 0) return { content: `${dir}\n（空目录）` }
    const sorted = [...entries].sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
    )
    const lines = sorted
      .slice(0, MAX_LIST_ENTRIES)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    const more =
      sorted.length > MAX_LIST_ENTRIES ? `\n…（共 ${sorted.length} 项，仅显示前 ${MAX_LIST_ENTRIES} 项）` : ''
    return { content: truncate(`${dir}\n${lines.join('\n')}${more}`) }
  },
}

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取项目内一个文本文件的内容（带行号）。大文件可用 offset/limit 分段读取。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '项目内相对路径' },
      offset: { type: 'integer', description: '起始行（从 1 开始），默认 1' },
      limit: { type: 'integer', description: '最多读取行数，默认 400' },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    const rel = typeof input.path === 'string' ? input.path : ''
    if (!rel) return { content: '缺少 path 参数', isError: true }
    const file = safeResolve(ctx.projectPath, rel)
    const raw = await readFile(file, 'utf-8')
    const allLines = raw.split('\n')
    const offset = Math.max(1, typeof input.offset === 'number' ? Math.floor(input.offset) : 1)
    const limit = Math.min(MAX_READ_LINES, typeof input.limit === 'number' ? Math.floor(input.limit) : 400)
    const slice = allLines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((line, i) => `${String(offset + i).padStart(5)}| ${line}`)
    const note =
      offset - 1 + slice.length < allLines.length
        ? `\n…（共 ${allLines.length} 行，可用 offset/limit 继续读取）`
        : ''
    return { content: truncate(numbered.join('\n') + note) }
  },
}

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    '创建或覆盖项目内的一个文本文件（整文件写入，父目录不存在会自动创建）。该操作会修改用户磁盘，写入前需要用户批准；被拒绝时请改用其他方案或向用户说明。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '项目内相对路径' },
      content: { type: 'string', description: '完整的文件内容（UTF-8 文本）' },
    },
    required: ['path', 'content'],
  },
  requiresApproval: true,
  kind: 'edit',
  async execute(input, ctx) {
    const rel = typeof input.path === 'string' ? input.path : ''
    const content = typeof input.content === 'string' ? input.content : null
    if (!rel) return { content: '缺少 path 参数', isError: true }
    if (content == null) return { content: '缺少 content 参数', isError: true }
    if (content.length > MAX_WRITE_CHARS) {
      return { content: `内容过大（${content.length} 字符，上限 ${MAX_WRITE_CHARS}），拒绝写入`, isError: true }
    }
    const file = safeResolve(ctx.projectPath, rel)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content, 'utf-8')
    const lines = content.split('\n').length
    return { content: `已写入 ${rel}（${lines} 行，${content.length} 字符）` }
  },
}

const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    '对项目内一个文本文件做精准的字符串替换编辑。oldText 必须与文件现有内容逐字符一致（含缩进与换行）；小改动用它，整文件重写用 write_file。该操作会修改用户磁盘，写入前需要用户批准；被拒绝时请向用户说明并调整方案。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '项目内相对路径' },
      oldText: { type: 'string', description: '要被替换的原文（逐字符匹配；若出现多次请扩大上下文范围）' },
      newText: { type: 'string', description: '替换后的新文本（删除内容时传空字符串）' },
      replace_all: { type: 'boolean', description: 'oldText 出现多次时是否全部替换，默认只允许唯一匹配' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  requiresApproval: true,
  kind: 'edit',
  async execute(input, ctx) {
    const rel = typeof input.path === 'string' ? input.path : ''
    const oldText = typeof input.oldText === 'string' ? input.oldText : ''
    const newText = typeof input.newText === 'string' ? input.newText : ''
    const replaceAll = input.replace_all === true
    if (!rel) return { content: '缺少 path 参数', isError: true }
    if (!oldText) return { content: '缺少 oldText 参数', isError: true }

    const file = safeResolve(ctx.projectPath, rel)
    const raw = await readFile(file, 'utf-8')
    const count = raw.split(oldText).length - 1
    if (count === 0) {
      return {
        content: `oldText 在 ${rel} 中未找到。请先用 read_file 确认实际内容——oldText 必须与文件逐字符一致（含缩进）`,
        isError: true,
      }
    }
    if (count > 1 && !replaceAll) {
      return {
        content: `oldText 在 ${rel} 中出现了 ${count} 次。请扩大 oldText 的上下文使其唯一，或设置 replace_all=true`,
        isError: true,
      }
    }

    const updated = replaceAll ? raw.split(oldText).join(newText) : raw.replace(oldText, newText)
    await writeFile(file, updated, 'utf-8')
    const replaced = replaceAll ? count : 1
    return { content: `已编辑 ${rel}（替换 ${replaced} 处，-${oldText.length} +${newText.length} 字符）` }
  },
}

/** Windows 下终止整个进程树（shell:true 时命令包在 cmd.exe 里，直接 kill 会漏掉子进程） */
function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
}

const RUN_COMMAND_TIMEOUT_MS = 60_000

const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    '在项目目录下执行一条 shell 命令（Windows 用 cmd，60 秒超时自动终止整个进程树），返回退出码与合并后的 stdout/stderr。用于运行脚本、测试、安装依赖、查看系统信息等。该操作在用户机器上真实执行，需要用户批准；非零退出码视为失败，输出里通常有报错信息。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令（shell 语法）' },
      cwd: { type: 'string', description: '工作目录（项目内相对路径，默认项目根目录）' },
    },
    required: ['command'],
  },
  requiresApproval: true,
  kind: 'system',
  timeoutMs: RUN_COMMAND_TIMEOUT_MS,
  async execute(input, ctx) {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command.trim()) return { content: '缺少 command 参数', isError: true }
    const cwd = safeResolve(ctx.projectPath, typeof input.cwd === 'string' ? input.cwd : '.')

    return new Promise((resolvePromise) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let out = ''
      let truncated = false
      const append = (data: Buffer): void => {
        if (out.length >= MAX_OUTPUT_CHARS) {
          truncated = true
          return // 继续排空流让进程正常结束，只是不再记录
        }
        out += data.toString('utf-8')
        if (out.length > MAX_OUTPUT_CHARS) {
          out = out.slice(0, MAX_OUTPUT_CHARS)
          truncated = true
        }
      }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)

      // 自身超时：杀掉整个进程树并以错误结果收场（先于通用 15s 超时，因为本工具更长）
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, RUN_COMMAND_TIMEOUT_MS)

      child.on('error', (err) => {
        clearTimeout(timer)
        resolvePromise({ content: `命令启动失败：${err.message}`, isError: true })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const notes = [
          timedOut ? '命令超时 60 秒，已强制终止进程树' : '',
          truncated ? `输出过长，已截断到 ${MAX_OUTPUT_CHARS} 字符` : '',
        ].filter(Boolean)
        resolvePromise({
          content: truncate(`退出码: ${code ?? 'N/A'}\n${out}${notes.length ? `\n${notes.join('；')}` : ''}`),
          isError: timedOut || (code !== 0 && code !== null),
        })
      })
    })
  },
}

const registry = new Map<string, ToolDefinition>([
  [listFiles.name, listFiles],
  [readFileTool.name, readFileTool],
  [writeFileTool.name, writeFileTool],
  [editFileTool.name, editFileTool],
  [runCommandTool.name, runCommandTool],
])

/** 当前启用的工具列表（未来可按权限/开关过滤） */
export function getToolDefinitions(): ToolDefinition[] {
  return [...registry.values()]
}

export interface ToolRunResult {
  content: string
  isError: boolean
  durationMs: number
}

/** 执行一次工具调用：含超时、异常转结果、结果截断。未知工具/无项目目录也转成错误结果 */
export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  projectPath: string | null,
): Promise<ToolRunResult> {
  const started = Date.now()
  const tool = registry.get(name)
  const timeoutMs = tool?.timeoutMs ?? TOOL_TIMEOUT_MS
  const run = async (): Promise<ToolOutput> => {
    if (!projectPath) return { content: '当前没有激活的项目目录，无法使用文件工具', isError: true }
    if (!tool) return { content: `未知工具：${name}`, isError: true }
    return tool.execute(input, { projectPath })
  }

  let out: ToolOutput
  try {
    out = await Promise.race([
      run().catch((err: unknown) => ({
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      })),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`工具执行超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs)
        t.unref()
      }),
    ])
  } catch (err) {
    out = { content: err instanceof Error ? err.message : String(err), isError: true }
  }
  return { content: truncate(out.content), isError: Boolean(out.isError), durationMs: Date.now() - started }
}

/** 把流里解析出的工具调用块安全地执行掉（供 llm.ts 的代理循环使用） */
export async function runToolUseBlock(
  block: ToolUseBlock,
  projectPath: string | null,
): Promise<ToolRunResult> {
  return executeToolCall(block.name, block.input, projectPath)
}

// ---------- 工具元数据（供"工具开关"设置页展示） ----------

export interface ToolMeta {
  name: string
  description: string
  requiresApproval: boolean
  kind: 'read' | 'edit' | 'system' | undefined
}

export function registerToolHandlers(): void {
  ipcMain.handle('tools:list', (): ToolMeta[] =>
    getToolDefinitions().map((d) => ({
      name: d.name,
      description: d.description,
      requiresApproval: Boolean(d.requiresApproval),
      kind: d.kind,
    })),
  )
}
