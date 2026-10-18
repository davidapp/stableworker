import { describe, expect, it, beforeAll } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeToolCall } from '../src/main/tools'
import { getShellTask, stopShellTask } from '../src/main/tools/shellTasks'

let project = ''
const FG_MS = 800 // 宽限期压到 800ms，测试秒级完成

beforeAll(async () => {
  process.env.SW_RUN_COMMAND_FOREGROUND_MS = String(FG_MS)
  project = await mkdtemp(join(tmpdir(), 'sw-handoff-'))
})

describe('run_command 超时转后台', () => {
  it('宽限期后不杀进程：命令转入后台继续跑，task_output 可轮询', async () => {
    // 命令：立刻输出 ready，然后每 200ms 检查 go 文件，出现则写 done 并退出（最长 30s）
    const cmd = `node -e "console.log('ready');const fs=require('fs');const i=setInterval(function(){try{if(fs.existsSync('go')){fs.writeFileSync('done','1');clearInterval(i);process.exit(0)}}catch(e){}},200)"`
    const result = await executeToolCall('run_command', { command: cmd }, project, {})
    expect(result.content).toContain('转入后台')
    expect(result.content).toMatch(/任务 id: (bash-\d+)/)
    expect(result.isError).toBe(false)

    // 后台任务在注册表里且仍在运行
    const id = (result.content.match(/bash-\d+/) ?? [''])[0]
    expect(getShellTask(id)?.status).toBe('running')

    // 触发退出条件 → 轮询到任务完成 → done 文件存在
    await new Promise((r) => setTimeout(r, 300))
    await writeFile(join(project, 'go'), '1')
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200))
      const t = getShellTask(id)
      if (t && t.status !== 'running') break
    }
    expect(await readFile(join(project, 'done'), 'utf-8')).toBe('1')
    stopShellTask(id)
  }, 30_000)
})
