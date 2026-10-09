import { app, ipcMain } from 'electron'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 斜杠命令 / Skills：userData/skills/<name>.md，一个文件一条命令。
 * 文件内容即发送给模型的 prompt 模板，支持 $ARGUMENTS（全部参数）与
 * $1/$2（位置参数）占位符。以 /name args 形式在输入框触发。
 */

function skillsDir(): string {
  return join(app.getPath('userData'), 'skills')
}

export interface SkillMeta {
  name: string
  content: string
}

async function readSkill(name: string): Promise<string | null> {
  try {
    return await readFile(join(skillsDir(), `${name}.md`), 'utf-8')
  } catch {
    return null
  }
}

/** 解析 /name args → 展开后的 prompt；未命中返回 null */
export async function resolveSlashCommand(text: string): Promise<string | null> {
  if (!text.startsWith('/')) return null
  const trimmed = text.slice(1)
  const sp = trimmed.indexOf(' ')
  const name = sp < 0 ? trimmed : trimmed.slice(0, sp)
  const args = sp < 0 ? '' : trimmed.slice(sp + 1).trim()
  if (!name) return null
  const tpl = await readSkill(name)
  if (tpl == null) return null
  const positional = args ? args.split(/\s+/) : []
  return tpl.replaceAll('$ARGUMENTS', args).replaceAll(/\$(\d+)/g, (_, n) => positional[Number(n) - 1] ?? '')
}

export function registerSkillHandlers(): void {
  ipcMain.handle('skills:list', async (): Promise<SkillMeta[]> => {
    try {
      const files = (await readdir(skillsDir()).catch(() => [] as string[])).filter((f) => f.endsWith('.md'))
      const out: SkillMeta[] = []
      for (const f of files) {
        const content = await readFile(join(skillsDir(), f), 'utf-8').catch(() => '')
        out.push({ name: f.slice(0, -3), content })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return []
    }
  })

  ipcMain.handle('skills:save', async (_e, name: string, content: string): Promise<{ ok: boolean; error?: string }> => {
    const safe = name.trim().replace(/[^\w-]/g, '')
    if (!safe) return { ok: false, error: '命令名只能包含字母、数字、下划线和连字符' }
    await mkdir(skillsDir(), { recursive: true })
    await writeFile(join(skillsDir(), `${safe}.md`), content, 'utf-8')
    return { ok: true }
  })

  ipcMain.handle('skills:delete', async (_e, name: string): Promise<boolean> => {
    await rm(join(skillsDir(), `${name}.md`), { force: true })
    return true
  })

  ipcMain.handle('skills:resolve', async (_e, text: string): Promise<{ found: boolean; content?: string }> => {
    const expanded = await resolveSlashCommand(text)
    return expanded == null ? { found: false } : { found: true, content: expanded }
  })
}
