import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/**
 * 后台 shell 任务：run_command 以 run_in_background 启动的长驻进程。
 * - 输出逐块累积（上限 100KB，超限继续排空但不记录）
 * - 无超时（长驻进程如 dev server），只能用 task_stop 终止（杀整个进程树）
 * - 完成后保留在注册表中供 task_output 查询，数量超上限时淘汰最旧的已完成任务
 */

export interface ShellTask {
  id: string
  command: string
  cwd: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  exitCode: number | null
  output: string
  truncated: boolean
  startedAt: number
  child: ChildProcess
  sessionId?: string
}

const tasks = new Map<string, ShellTask>()
const MAX_BG_OUTPUT = 100_000
const MAX_TASKS = 20

/** Windows 下终止整个进程树（shell:true 时命令包在 cmd.exe 里，直接 kill 会漏掉子进程） */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const fire = (): void => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      // 杀树失败要有迹可查（如 pid 已复用、权限问题），否则表现为"停不下来"且无日志
      killer.stderr?.on('data', (d: Buffer) => console.error('[shellTasks] taskkill stderr:', d.toString().trim()))
      killer.on('close', (code) => {
        if (code !== 0) console.error(`[shellTasks] taskkill 退出码 ${code}（pid=${child.pid}）`)
      })
    }
    fire()
    // 二次保险：高负载下 taskkill 的进程快照可能与 pid 复用竞态（报成功但孙进程漏杀），
    // 200ms 后子进程仍活着就补一枪
    const t = setTimeout(() => {
      try {
        if (!child.killed && child.exitCode == null) fire()
      } catch { /* 进程对象已失效 */ }
    }, 200)
    t.unref?.()
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

export function startShellTask(id: string, command: string, cwd: string, sessionId?: string, signal?: AbortSignal): ShellTask {
  signal?.throwIfAborted()
  // 超上限时先淘汰最旧的已完成任务
  const all = [...tasks.values()]
  if (all.length >= MAX_TASKS) {
    const finished = all.filter((t) => t.status !== 'running').sort((a, b) => a.startedAt - b.startedAt)
    if (finished.length > 0) tasks.delete(finished[0].id)
    else throw new Error(`后台任务已达到上限 ${MAX_TASKS}，请先停止一个任务`)
  }

  const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const task: ShellTask = {
    id,
    command,
    cwd,
    status: 'running',
    exitCode: null,
    output: '',
    truncated: false,
    startedAt: Date.now(),
    child,
    sessionId,
  }
  tasks.set(id, task)

  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  const append = (data: string): void => {
    if (task.output.length >= MAX_BG_OUTPUT) {
      task.truncated = true
      return
    }
    task.output += data
    if (task.output.length > MAX_BG_OUTPUT) {
      task.output = task.output.slice(0, MAX_BG_OUTPUT)
      task.truncated = true
    }
  }
  child.stdout?.on('data', (data: Buffer) => append(stdoutDecoder.write(data)))
  child.stderr?.on('data', (data: Buffer) => append(stderrDecoder.write(data)))
  const onAbort = (): void => { stopShellTask(id) }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  child.on('error', (err) => {
    if (task.status === 'running') {
      task.status = 'failed'
      task.output += `\n启动失败：${err.message}`
    }
  })
  child.on('close', (code) => {
    signal?.removeEventListener('abort', onAbort)
    append(stdoutDecoder.end() + stderrDecoder.end())
    if (task.status === 'running') {
      task.exitCode = code
      task.status = code === 0 ? 'completed' : 'failed'
    }
  })
  return task
}

export function getShellTask(id: string): ShellTask | undefined {
  return tasks.get(id)
}

/** 终止后台任务（杀整个进程树），返回任务是否存在 */
export function stopShellTask(id: string): boolean {
  const t = tasks.get(id)
  if (!t) return false
  if (t.status === 'running') {
    killTree(t.child)
    t.status = 'killed'
  }
  return true
}

export function stopSessionShellTasks(sessionId: string): void {
  for (const task of tasks.values()) if (task.sessionId === sessionId) stopShellTask(task.id)
}

export function stopAllShellTasks(): void {
  for (const task of tasks.values()) stopShellTask(task.id)
}
