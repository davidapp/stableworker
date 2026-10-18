import { describe, expect, it } from 'vitest'
import { parseSkillFrontmatter, substituteArgs } from '../src/shared/skillFrontmatter'
import { spawn } from 'node:child_process'

/** skills.ts 的 runEmbeddedCommand 未导出，用同协议最小复刻测内嵌执行语义（超时/退出码/输出） */
function runEmbedded(command: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    const parts: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < command.length; i++) {
      const ch = command[i]
      if (ch === '\\' && inQuote && command[i + 1] === '"') { cur += '"'; i++; continue }
      if (ch === '"') { inQuote = !inQuote; continue }
      if (ch === ' ' && !inQuote) { if (cur) { parts.push(cur); cur = '' } continue }
      cur += ch
    }
    if (cur) parts.push(cur)
    const child = spawn(parts[0], parts.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; if (!child.killed) child.kill() }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = out.trim().slice(0, 10_000)
      resolve(timedOut ? `（命令超时，部分输出：${text}）` : `（退出码 ${code}）\n${text}`)
    })
  })
}

describe('skill frontmatter 解析', () => {
  it('解析 description / allowed-tools / model，正文剥离 frontmatter', () => {
    const raw = ['---', 'description: 评审代码', 'allowed-tools: read_file, grep', 'model: deepseek-pro', '---', '正文 $ARGUMENTS'].join('\n')
    const { meta, body } = parseSkillFrontmatter(raw)
    expect(meta).toEqual({ description: '评审代码', allowedTools: ['read_file', 'grep'], model: 'deepseek-pro' })
    expect(body).toBe('正文 $ARGUMENTS')
  })

  it('无 frontmatter 原样返回；值里允许冒号', () => {
    expect(parseSkillFrontmatter('plain body')).toEqual({ meta: {}, body: 'plain body' })
    const { meta } = parseSkillFrontmatter('---\ndescription: a: b\n---\nx')
    expect(meta.description).toBe('a: b')
  })

  it('substituteArgs：$ARGUMENTS 与位置参数', () => {
    expect(substituteArgs('review $1 到 $2（$ARGUMENTS）', 'a b')).toBe('review a 到 b（a b）')
    expect(substituteArgs('no args: $3', 'x')).toBe('no args: ')
  })
})

describe('内嵌命令执行语义', () => {
  it('输出就地注入格式（退出码 + 内容）', async () => {
    const out = await runEmbedded(`node -e "console.log('hello-embed')"`)
    expect(out).toContain('（退出码 0）')
    expect(out).toContain('hello-embed')
  })

  it('非零退出码保留 stderr 内容', async () => {
    const out = await runEmbedded(`node -e "console.error('boom');process.exit(3)"`)
    expect(out).toContain('（退出码 3）')
    expect(out).toContain('boom')
  }, 15_000)

  it('超时标记并保留部分输出', async () => {
    const out = await runEmbedded(`node -e "console.log('partial');setInterval(function(){},1000)"`, 1500)
    expect(out).toContain('（命令超时')
    expect(out).toContain('partial')
  }, 15_000)
})
