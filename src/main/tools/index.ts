import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { ipcMain } from 'electron'
import { safeResolve } from './paths'
import { startShellTask, adoptShellTask, getShellTask, stopShellTask, killTree } from './shellTasks'
import { smartDecode } from './smartDecode'
import { loadSkillContent, listSkillNames } from '../skills'
import { grepTool, globTool } from './search'
import { webFetchTool } from './webFetch'
import { memoryTool } from '../memoryDir'
import { enterPlanModeTool, exitPlanModeTool } from '../planTools'
import { webSearchTool } from './webSearch'
import type { TodoItem, ToolUseBlock } from '../../shared/types'

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
  /** 可选：当前会话 id（run_command 的 cwd 跨调用保持用） */
  sessionId?: string
  /** 请求停止或超时时，底层进程/网络也必须停止。 */
  signal?: AbortSignal
  /** 可选：把执行过程的实时输出（如命令的 stdout 流）推给聊天界面 */
  onOutput?: (text: string) => void
  /** 可选：更新当前会话的任务清单（todo_write 用） */
  onTodos?: (todos: TodoItem[]) => void
  /** 可选：向用户提出结构化问题并等待回答（ask_user_question 用） */
  onAskUser?: (q: { question: string; options: string[] }) => Promise<string>
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

/** 会话保持的工作目录（run_command 的 cd 跨调用记忆，key = sessionId） */
const sessionCwd = new Map<string, string>()
let bgSeq = 0
const MAX_READ_LINES = 2000
const MAX_OUTPUT_CHARS = 20_000
const MAX_WRITE_CHARS = 500_000
const TOOL_TIMEOUT_MS = 15_000

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? text.slice(0, MAX_OUTPUT_CHARS) + `\n…（结果过长，已截断到 ${MAX_OUTPUT_CHARS} 字符）`
    : text
}

/** file-state 缓存：abs 路径 → 最近一次已知内容（read_file 记录，Edit 用于"先读后改"校验） */
const fileStateCache = new Map<string, string>()

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
    const raw = await readFile(file, { encoding: 'utf-8', signal: ctx.signal })
    fileStateCache.set(file, raw) // 记录读取快照，供 edit_file 校验"先读后改"
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
    ctx.signal?.throwIfAborted()
    safeResolve(ctx.projectPath, rel)
    await writeFile(file, content, { encoding: 'utf-8', signal: ctx.signal })
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
    const raw = await readFile(file, { encoding: 'utf-8', signal: ctx.signal })
    // "先读后改"校验：Edit 必须基于最近一次 Read 的快照，防止基于猜测的盲改
    const known = fileStateCache.get(file)
    if (known == null) {
      return { content: `编辑前必须先用 read_file 读取 ${rel}（防止基于猜测的盲改）`, isError: true }
    }
    if (known !== raw) {
      return {
        content: `${rel} 在上次读取后被修改过（外部编辑或命令改动）。请重新 read_file 获取最新内容后再编辑`,
        isError: true,
      }
    }
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
    ctx.signal?.throwIfAborted()
    safeResolve(ctx.projectPath, rel)
    await writeFile(file, updated, { encoding: 'utf-8', signal: ctx.signal })
    fileStateCache.set(file, updated) // 编辑后同步快照，后续编辑无需重复读取
    const replaced = replaceAll ? count : 1
    return { content: `已编辑 ${rel}（替换 ${replaced} 处，-${oldText.length} +${newText.length} 字符）` }
  },
}

const multiEditTool: ToolDefinition = {
  name: 'multi_edit',
  description:
    '对项目内一个文本文件做多处精准替换（edits 数组按顺序逐个应用）。适合一次修改同一文件的多处内容；其余语义与 edit_file 相同。该操作会修改用户磁盘，写入前需要用户批准。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '项目内相对路径' },
      edits: {
        type: 'array',
        description: '替换列表（按顺序应用）',
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string', description: '要被替换的原文' },
            newText: { type: 'string', description: '替换后的新文本' },
            replace_all: { type: 'boolean', description: '是否全部替换（默认唯一匹配）' },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  requiresApproval: true,
  kind: 'edit',
  async execute(input, ctx) {
    const rel = typeof input.path === 'string' ? input.path : ''
    const edits = Array.isArray(input.edits) ? input.edits : null
    if (!rel) return { content: '缺少 path 参数', isError: true }
    if (!edits || edits.length === 0) return { content: '缺少 edits 参数', isError: true }

    const file = safeResolve(ctx.projectPath, rel)
    let raw = await readFile(file, { encoding: 'utf-8', signal: ctx.signal })
    const applied: string[] = []
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] as { oldText?: unknown; newText?: unknown; replace_all?: unknown }
      const oldText = typeof e.oldText === 'string' ? e.oldText : ''
      const newText = typeof e.newText === 'string' ? e.newText : ''
      const replaceAll = e.replace_all === true
      if (!oldText) {
        return { content: `第 ${i + 1} 处替换缺少 oldText`, isError: true }
      }
      const count = raw.split(oldText).length - 1
      if (count === 0) {
        return {
          content: `第 ${i + 1} 处替换的 oldText 在 ${rel} 中未找到（前面的替换可能改变了上下文）。当前已应用 ${i} 处、尚未写盘——请重新 read_file 后调整`,
          isError: true,
        }
      }
      if (count > 1 && !replaceAll) {
        return {
          content: `第 ${i + 1} 处替换的 oldText 出现了 ${count} 次。请扩大上下文或设置 replace_all`,
          isError: true,
        }
      }
      raw = replaceAll ? raw.split(oldText).join(newText) : raw.replace(oldText, newText)
      applied.push(`#${i + 1}（-${oldText.length} +${newText.length} 字符）`)
    }
    ctx.signal?.throwIfAborted()
    safeResolve(ctx.projectPath, rel)
    await writeFile(file, raw, { encoding: 'utf-8', signal: ctx.signal })
    return { content: `已编辑 ${rel}（共 ${applied.length} 处：${applied.join('、')}）` }
  },
}

// 前台宽限期：超过后不杀进程，自动转入后台（环境变量可覆盖，测试用）
function runCommandForegroundMs(): number {
  return Number(process.env.SW_RUN_COMMAND_FOREGROUND_MS ?? 60_000)
}

const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    '在项目目录下执行一条 shell 命令（Windows 用 cmd），返回退出码与合并后的 stdout/stderr。用于运行脚本、测试、安装依赖、查看系统信息等。该操作在用户机器上真实执行，需要用户批准；非零退出码视为失败，输出里通常有报错信息。工作目录在多次调用间保持（cd 会记住）；run_in_background=true 时立即返回、进程持续运行（用 task_output 查询、task_stop 终止），适合 dev server / watch 等长驻命令。前台命令运行超过 60 秒未结束时自动转入后台继续执行（不终止），并返回任务 id 供 task_output 轮询。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令（shell 语法）' },
      cwd: { type: 'string', description: '工作目录（项目内相对路径，默认上次所在目录）' },
      run_in_background: { type: 'boolean', description: 'true = 后台运行：立即返回任务 id，输出用 task_output 查询' },
    },
    required: ['command'],
  },
  requiresApproval: true,
  kind: 'system',
  timeoutMs: runCommandForegroundMs() + 5_000,
  async execute(input, ctx) {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command.trim()) return { content: '缺少 command 参数', isError: true }

    // 工作目录：显式 cwd > 会话保持的上次目录 > 项目根（均限制在项目内）
    const persisted = ctx.sessionId ? sessionCwd.get(ctx.sessionId) : undefined
    const candidate = resolve(persisted ?? ctx.projectPath, typeof input.cwd === 'string' && input.cwd ? input.cwd : '.')
    const cwd = safeResolve(ctx.projectPath, relative(ctx.projectPath, candidate))
    ctx.signal?.throwIfAborted()

    // 后台运行：启动即返回，输出累积在任务注册表里（无超时）
    if (input.run_in_background === true) {
      const id = `bash-${++bgSeq}`
      startShellTask(id, command, cwd, ctx.sessionId, ctx.signal)
      return {
        content: `后台任务已启动（id: ${id}）\n命令: ${command}\n用 task_output 工具查询输出（任务无超时）；用 task_stop 终止。`,
      }
    }

    // 前台：60 秒超时强杀；成功后检测 cd 更新会话保持的目录
    return new Promise((resolvePromise) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const chunks: Buffer[] = []
      let totalLen = 0
      let truncated = false
      const append = (data: Buffer): void => {
        // 实时推给聊天卡片（UTF-8 快速解码；最终结果在 close 时做智能解码纠偏）
        if (ctx.onOutput && totalLen < MAX_OUTPUT_CHARS) ctx.onOutput(smartDecode(data))
        if (totalLen >= MAX_OUTPUT_CHARS) {
          truncated = true
          return // 继续排空流让进程正常结束，只是不再记录
        }
        chunks.push(data)
        totalLen += data.length
        if (totalLen > MAX_OUTPUT_CHARS) {
          const over = totalLen - MAX_OUTPUT_CHARS
          chunks[chunks.length - 1] = chunks[chunks.length - 1].subarray(0, chunks[chunks.length - 1].length - over)
          truncated = true
        }
      }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)

      // 宽限期到：不杀进程，把仍在运行的命令收编为后台任务（模型用 task_output 轮询进度）
      let cancelled = false
      const onAbort = (): void => { cancelled = true; killTree(child) }
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      if (ctx.signal?.aborted) onAbort()
      const timer = setTimeout(() => {
        const id = `bash-${++bgSeq}`
        adoptShellTask(id, command, cwd, child, ctx.sessionId)
        resolvePromise({
          content:
            `命令已运行 ${Math.round(runCommandForegroundMs() / 1000)} 秒仍未结束，已自动转入后台继续执行（不终止）。
` +
            `任务 id: ${id}
用 task_output 工具轮询进度与输出；确认不需要时用 task_stop 终止。`,
        })
      }, runCommandForegroundMs())

      child.on('error', (err) => {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
        resolvePromise({ content: `命令启动失败：${err.message}`, isError: true })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
        // cwd 保持：命令成功且以 cd 开头时，把会话工作目录更新为 cd 的目标
        if (code === 0 && ctx.sessionId) {
          const cd = command.match(/^\s*cd\s+"?([^"&|\n]+?)"?\s*(?:&&|$)/i)
          if (cd) {
            try {
              const next = safeResolve(ctx.projectPath, relative(ctx.projectPath, resolve(cwd, cd[1].trim())))
              sessionCwd.set(ctx.sessionId, next)
            } catch {
              // 越界目标忽略，保持原目录
            }
          }
        }
        const notes = [
          cancelled ? '用户已停止，进程树已终止' : '',
          truncated ? `输出过长，已截断到 ${MAX_OUTPUT_CHARS} 字符` : '',
        ].filter(Boolean)
        const decoded = smartDecode(Buffer.concat(chunks)).slice(0, MAX_OUTPUT_CHARS + 1000)
        resolvePromise({
          content: truncate(`退出码: ${code ?? 'N/A'}\n${decoded}${notes.length ? `\n${notes.join('；')}` : ''}`),
          isError: cancelled || code !== 0,
        })
      })
    })
  },
}

const todoWriteTool: ToolDefinition = {
  name: 'todo_write',
  description:
    '维护当前会话的任务清单，用于复杂任务（≥3 步）的进度跟踪。每次调用传入完整清单（全量替换）；开始一项时置 in_progress，完成后立即置 completed。简单任务不要使用。',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整任务清单（全量替换）',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '任务内容（一句话）' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: '任务状态',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(input, ctx) {
    const todos = Array.isArray(input.todos) ? input.todos : null
    if (!todos) return { content: '缺少 todos 参数', isError: true }
    const list: TodoItem[] = todos
      .filter((t) => t && typeof (t as { content?: unknown }).content === 'string')
      .map((t, i) => {
        const o = t as { content?: string; status?: string; id?: string }
        return {
          id: typeof o.id === 'string' && o.id ? o.id : `todo-${i + 1}`,
          content: String(o.content).slice(0, 200),
          status: o.status === 'in_progress' || o.status === 'completed' ? o.status : ('pending' as const),
        }
      })
    ctx.onTodos?.(list)
    const done = list.filter((t) => t.status === 'completed').length
    return { content: `任务清单已更新（共 ${list.length} 项，已完成 ${done} 项）` }
  },
}

const askUserQuestionTool: ToolDefinition = {
  name: 'ask_user_question',
  description:
    '向用户提出结构化的选择题并等待回答（挂起直到用户作答）。用于需要用户决策的关键分歧点：方案选择、方向确认、信息补充。不要用于可以用工具自己查到答案的问题。',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '问题内容（一句话）' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '2–4 个选项，每个选项一句话',
      },
    },
    required: ['question', 'options'],
  },
  // 无超时：一直等用户作答（对齐 Claude Code）；用户点停止可随时打断
  timeoutMs: Number.POSITIVE_INFINITY,
  async execute(input, ctx) {
    const question = typeof input.question === 'string' ? input.question : ''
    const options = Array.isArray(input.options)
      ? (input.options as unknown[]).filter((o): o is string => typeof o === 'string' && o.trim() !== '').slice(0, 4)
      : []
    if (!question || options.length < 2) {
      return { content: '需要 question 与至少 2 个 options', isError: true }
    }
    if (!ctx.onAskUser) return { content: '当前界面不支持向用户提问', isError: true }
    const answer = await ctx.onAskUser({ question, options })
    return { content: `用户选择了：${answer}` }
  },
}

const taskOutputTool: ToolDefinition = {
  name: 'task_output',
  description: '查看后台任务的状态与已累积输出（run_command 以 run_in_background 启动的任务）。可反复调用轮询进度。',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '后台任务 id（run_command 后台启动时返回）' },
    },
    required: ['task_id'],
  },
  kind: 'read',
  async execute(input) {
    const id = typeof input.task_id === 'string' ? input.task_id : ''
    const t = id ? getShellTask(id) : undefined
    if (!t) return { content: `任务不存在或已被清理：${id}`, isError: true }
    const tail = t.output.length > 8000 ? `…（前段已省略）\n${t.output.slice(-8000)}` : t.output
    const state = t.status === 'running' ? '运行中' : t.status === 'killed' ? '已终止' : t.status === 'completed' ? '已完成' : '失败'
    return {
      content: `任务 ${t.id} 状态: ${state}${t.exitCode != null ? `（退出码 ${t.exitCode}）` : ''}\n命令: ${t.command}\n${t.truncated ? '（输出超长已截断）\n' : ''}${tail ? `\n${tail}` : '\n（暂无输出）'}`,
    }
  },
}

const taskStopTool: ToolDefinition = {
  name: 'task_stop',
  description: '终止一个后台任务（强杀整个进程树）。',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '后台任务 id' },
    },
    required: ['task_id'],
  },
  kind: 'read',
  async execute(input) {
    const id = typeof input.task_id === 'string' ? input.task_id : ''
    if (!stopShellTask(id)) return { content: `任务不存在：${id}`, isError: true }
    return { content: `任务 ${id} 已终止` }
  },
}

const skillTool: ToolDefinition = {
  name: 'skill',
  description:
    '调用一个用户自定义的斜杠命令（skill）：加载其 markdown 模板作为工作指令并照做。适合执行用户预定义的工作流（如代码审查、提交规范）。不确定有哪些命令时，可先不带参数调用，会返回可用命令列表。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '命令名称（不含 / 前缀）' },
      args: { type: 'string', description: '传给模板的参数（替换 $ARGUMENTS）' },
    },
    required: ['name'],
  },
  kind: 'read',
  async execute(input, ctx) {
    void ctx
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const args = typeof input.args === 'string' ? input.args : ''
    if (!name) {
      const all = await listSkillNames()
      return { content: all.length ? `可用的 skill：${all.join('、')}` : '当前没有任何自定义 skill（可在设置 → 斜杠命令中创建）' }
    }
    const loaded = await loadSkillContent(name, args)
    if (loaded == null) {
      return { content: `skill「${name}」不存在。请确认名称，或在设置 → 斜杠命令中创建。`, isError: true }
    }
    // frontmatter 只是斜杠触发时的约束元数据（allowed-tools/model），对模型调用的 Skill 工具
    // 只需返回展开后的模板正文
    return { content: loaded.content }
  },
}

const registry = new Map<string, ToolDefinition>([
  [listFiles.name, listFiles],
  [readFileTool.name, readFileTool],
  [grepTool.name, grepTool],
  [globTool.name, globTool],
  [writeFileTool.name, writeFileTool],
  [editFileTool.name, editFileTool],
  [multiEditTool.name, multiEditTool],
  [runCommandTool.name, runCommandTool],
  [taskOutputTool.name, taskOutputTool],
  [taskStopTool.name, taskStopTool],
  [todoWriteTool.name, todoWriteTool],
  [skillTool.name, skillTool],
  [askUserQuestionTool.name, askUserQuestionTool],
  [webFetchTool.name, webFetchTool],
  [memoryTool.name, memoryTool],
  [enterPlanModeTool.name, enterPlanModeTool],
  [exitPlanModeTool.name, exitPlanModeTool],
  [webSearchTool.name, webSearchTool],
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

/** 执行一次工具调用：含超时、异常转结果、结果截断。未知工具/无项目目录也转成错误结果。
 * signal 来自请求的中止控制器——用户点"停止"时，正在执行的工具（如长命令）也会被打断；
 * onOutput 用于把执行过程输出实时推给界面 */
export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  projectPath: string | null,
  opts: {
    /** 已经过权限门禁的当前工具定义（包含按会话创建的 task 与 MCP 工具） */
    definition?: ToolDefinition
    signal?: AbortSignal
    onOutput?: (text: string) => void
    onTodos?: (todos: TodoItem[]) => void
    sessionId?: string
    onAskUser?: (q: { question: string; options: string[] }) => Promise<string>
  } = {},
): Promise<ToolRunResult> {
  const started = Date.now()
  const tool = opts.definition?.name === name ? opts.definition : registry.get(name)
  const timeoutMs = tool?.timeoutMs ?? TOOL_TIMEOUT_MS
  const controller = new AbortController()
  const abortUnderlying = (): void => controller.abort(opts.signal?.reason ?? new Error('用户已停止，操作中断'))
  if (opts.signal?.aborted) abortUnderlying()
  else opts.signal?.addEventListener('abort', abortUnderlying, { once: true })
  const run = async (): Promise<ToolOutput> => {
    if (controller.signal.aborted) return { content: '用户已停止，操作中断', isError: true }
    if (!projectPath) return { content: '当前没有激活的项目目录，无法使用文件工具', isError: true }
    if (!tool) return { content: `未知工具：${name}`, isError: true }
    return tool.execute(input, {
      projectPath,
      sessionId: opts.sessionId,
      signal: controller.signal,
      onOutput: opts.onOutput,
      onTodos: opts.onTodos,
      onAskUser: opts.onAskUser,
    })
  }

  let timeout: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const race: Promise<ToolOutput | never>[] = [
    run().catch((err: unknown) => ({
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    })),
  ]
  // timeoutMs 为有限值时才设超时；Infinity（如 ask_user_question）表示无限等待
  if (Number.isFinite(timeoutMs)) {
    race.push(
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(`工具执行超时（${Math.round(timeoutMs / 1000)}s）`)
          reject(error)
          controller.abort(error)
        }, timeoutMs)
        timeout.unref()
      }),
    )
  }
  if (opts.signal) {
    race.push(
      new Promise<never>((_, reject) => {
        const signal = opts.signal as AbortSignal
        if (signal.aborted) {
          reject(new Error('用户已停止，操作中断'))
          return
        }
        onAbort = (): void => reject(new Error('用户已停止，操作中断'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    )
  }
  const out = await Promise.race(race)
    .catch((err: unknown) => ({
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    }))
    .finally(() => {
      if (timeout) clearTimeout(timeout)
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
      opts.signal?.removeEventListener('abort', abortUnderlying)
    })
  return { content: truncate(out.content), isError: Boolean(out.isError), durationMs: Date.now() - started }
}

/** 把流里解析出的工具调用块安全地执行掉（供 llm.ts 的代理循环使用） */
export async function runToolUseBlock(
  block: ToolUseBlock,
  projectPath: string | null,
  opts: {
    definition?: ToolDefinition
    signal?: AbortSignal
    onOutput?: (text: string) => void
    onTodos?: (todos: TodoItem[]) => void
    sessionId?: string
    onAskUser?: (q: { question: string; options: string[] }) => Promise<string>
  } = {},
): Promise<ToolRunResult> {
  return executeToolCall(block.name, block.input, projectPath, {
    definition: opts.definition,
    signal: opts.signal,
    onOutput: opts.onOutput,
    onTodos: opts.onTodos,
    sessionId: opts.sessionId,
    onAskUser: opts.onAskUser,
  })
}

// ---------- 工具元数据（供"工具开关"设置页展示） ----------

export interface ToolMeta {
  name: string
  description: string
  requiresApproval: boolean
  kind: 'read' | 'edit' | 'system' | undefined
}

export function registerToolHandlers(): void {
  ipcMain.handle('tools:list', async (_e, mode: 'coding' | 'office' = 'coding'): Promise<ToolMeta[]> => {
    const { toolsForTaskMode } = await import('../officeMode')
    const officeTools = mode === 'office' ? (await import('./office')).getOfficeToolDefinitions() : []
    const pool = mode === 'office' ? toolsForTaskMode('office', getToolDefinitions(), officeTools) : [...getToolDefinitions(), ...officeTools]
    return pool.map((d) => ({
      name: d.name,
      description: d.description,
      requiresApproval: Boolean(d.requiresApproval),
      kind: d.kind,
    }))
  })
}
