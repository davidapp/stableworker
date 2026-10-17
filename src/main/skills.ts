import { app, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from './config'
import { parseSkillFrontmatter, substituteArgs, type SkillFrontmatter } from '../shared/skillFrontmatter'
import { tokenize } from './mcp'
import type { SkillMeta } from '../shared/types'

/**
 * 斜杠命令 / Skills：两种作用域，同名时项目覆盖全局（对齐 Claude Code 的项目级 .claude/commands）：
 * - 全局：userData/skills/<name>.md
 * - 项目：<项目目录>/.stableworker/commands/<name>.md
 * 文件内容即发送给模型的 prompt 模板，支持 $ARGUMENTS（全部参数）与
 * $1/$2（位置参数）占位符。以 /name args 形式在输入框触发。
 */

function skillsDir(): string {
  return join(app.getPath('userData'), 'skills')
}

function projectCommandsDir(projectPath: string): string {
  return join(projectPath, '.stableworker', 'commands')
}

/** 当前激活项目的路径（项目级命令的存放/解析位置；无激活项目时为 null） */
async function activeProjectPath(): Promise<string | null> {
  const cfg = await loadConfig()
  if (!cfg.activeProjectId) return null
  return cfg.projects.find((p) => p.id === cfg.activeProjectId)?.path ?? null
}

async function readSkillFile(dir: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(dir, `${name}.md`), 'utf-8')
  } catch {
    return null
  }
}

/** 读取 skill 模板原文：项目作用域优先，全局兜底 */
async function readSkill(name: string): Promise<string | null> {
  const pp = await activeProjectPath()
  if (pp) {
    const project = await readSkillFile(projectCommandsDir(pp), name)
    if (project != null) return project
  }
  return readSkillFile(skillsDir(), name)
}

/** 列出某个目录下的命令（目录不存在返回空） */
async function listDirSkills(dir: string, scope: SkillMeta['scope']): Promise<SkillMeta[]> {
  const files = await readdir(dir).catch(() => [] as string[])
  const out: SkillMeta[] = []
  for (const f of files.filter((x) => x.endsWith('.md'))) {
    const content = await readFile(join(dir, f), 'utf-8').catch(() => '')
    out.push({ name: f.slice(0, -3), content, scope })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 列出所有 skill 名称（全局 + 项目去重，供 Skill 工具提示可用命令） */
export async function listSkillNames(): Promise<string[]> {
  const pp = await activeProjectPath()
  const [global, project] = await Promise.all([
    listDirSkills(skillsDir(), 'global').catch(() => []),
    pp ? listDirSkills(projectCommandsDir(pp), 'project').catch(() => []) : Promise.resolve([]),
  ])
  return [...new Set([...project, ...global].map((s) => s.name))].sort()
}

/** 读取 skill 模板并展开（frontmatter 元数据 + $参数替换 + !`命令` 内嵌执行） */
export interface LoadedSkill {
  content: string
  meta: SkillFrontmatter
}

/** 内嵌命令执行上限（防失控） */
const MAX_EMBEDDED = 20
const EMBED_TIMEOUT_MS = 10_000
const MAX_EMBED_OUTPUT = 10_000

async function runEmbeddedCommand(command: string): Promise<string> {
  return new Promise((resolve) => {
    const parts = tokenize(command)
    if (parts.length === 0) {
      resolve('（命令为空）')
      return
    }
    const child = spawn(parts[0], parts.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (!child.killed) child.kill()
    }, EMBED_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < MAX_EMBED_OUTPUT) out += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (out.length < MAX_EMBED_OUTPUT) out += d.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve(`（命令启动失败：${err.message}）`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = out.trim().slice(0, MAX_EMBED_OUTPUT)
      resolve(timedOut ? `（命令超时，部分输出：${text}）` : `（退出码 ${code}）\n${text}`)
    })
  })
}

/** 展开模板：$参数替换 → !`命令` 内嵌执行（结果就地注入） */
async function expandSkillBody(body: string, args: string): Promise<string> {
  const substituted = substituteArgs(body, args)
  const matches = [...substituted.matchAll(/!`([^`]+)`/g)].slice(0, MAX_EMBEDDED)
  if (matches.length === 0) return substituted
  const results = await Promise.all(matches.map((m) => runEmbeddedCommand(m[1])))
  let i = 0
  return substituted.replaceAll(/!`([^`]+)`/g, () => `\n[命令输出] $ ${matches[i][1]}\n${results[i++]}\n`)
}

/** 读取 skill 模板并展开（斜杠命令与 Skill 工具共用；带 frontmatter 元数据） */
export async function loadSkillContent(name: string, args: string): Promise<LoadedSkill | null> {
  const tpl = await readSkill(name)
  if (tpl == null) return null
  const { meta, body } = parseSkillFrontmatter(tpl)
  const content = await expandSkillBody(body, args)
  return { content, meta }
}

/** 解析 /name args → 展开后的 prompt + 元数据；未命中返回 null */
export async function resolveSlashCommand(
  text: string,
): Promise<{ content: string; meta: SkillFrontmatter } | null> {
  if (!text.startsWith('/')) return null
  const trimmed = text.slice(1)
  const sp = trimmed.indexOf(' ')
  const name = sp < 0 ? trimmed : trimmed.slice(0, sp)
  const args = sp < 0 ? '' : trimmed.slice(sp + 1).trim()
  if (!name) return null
  return loadSkillContent(name, args)
}

export function registerSkillHandlers(): void {
  // 两个作用域合并列出；同名只显示项目版（运行时它也是生效的那个）
  ipcMain.handle('skills:list', async (): Promise<SkillMeta[]> => {
    try {
      const pp = await activeProjectPath()
      const [global, project] = await Promise.all([
        listDirSkills(skillsDir(), 'global'),
        pp ? listDirSkills(projectCommandsDir(pp), 'project') : Promise.resolve([] as SkillMeta[]),
      ])
      const projectNames = new Set(project.map((s) => s.name))
      return [...project, ...global.filter((s) => !projectNames.has(s.name))]
    } catch {
      return []
    }
  })

  ipcMain.handle(
    'skills:save',
    async (_e, name: string, content: string, scope: SkillMeta['scope'] = 'global'): Promise<{ ok: boolean; error?: string }> => {
      const safe = name.trim().replace(/[^\w-]/g, '')
      if (!safe) return { ok: false, error: '命令名只能包含字母、数字、下划线和连字符' }
      let dir = skillsDir()
      if (scope === 'project') {
        const pp = await activeProjectPath()
        if (!pp) return { ok: false, error: '没有激活项目，无法保存项目级命令' }
        dir = projectCommandsDir(pp)
      }
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${safe}.md`), content, 'utf-8')
      return { ok: true }
    },
  )

  ipcMain.handle('skills:delete', async (_e, name: string, scope: SkillMeta['scope'] = 'global'): Promise<boolean> => {
    let dir = skillsDir()
    if (scope === 'project') {
      const pp = await activeProjectPath()
      if (!pp) return false
      dir = projectCommandsDir(pp)
    }
    await rm(join(dir, `${name}.md`), { force: true })
    return true
  })

  ipcMain.handle('skills:resolve', async (_e, text: string): Promise<{ found: boolean; content?: string; meta?: SkillFrontmatter }> => {
    const expanded = await resolveSlashCommand(text)
    return expanded == null ? { found: false } : { found: true, content: expanded.content, meta: expanded.meta }
  })
}
