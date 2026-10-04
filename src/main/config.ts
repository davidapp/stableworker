import { app, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import type { ConfigView, LLMConfig, ProjectInfo } from '../shared/types'

/**
 * 全局配置存储。
 * 设计借鉴 Claude Code：
 * - 单一全局 JSON 文件 + 内存缓存（读走缓存、写全量覆盖）
 * - apiKey 用 Electron safeStorage 加密后落盘；系统不支持时降级为带标记的明文
 * - 对渲染进程只暴露 ConfigView（apiKey 掩码），密钥原文永远不出主进程
 */

const ENCRYPTED_PREFIX = 'enc:v1:'
const PLAIN_PREFIX = 'plain:'

/** 落盘的完整配置形态（含 apiKey 明文/密文） */
interface StoredConfig {
  projects: ProjectInfo[]
  activeProjectId: string | null
  llm: (LLMConfig & { apiKey: string }) | null
}

let cache: StoredConfig | null = null

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export async function loadConfig(): Promise<StoredConfig> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(configPath(), 'utf-8')) as StoredConfig
  } catch {
    cache = { projects: [], activeProjectId: null, llm: null }
  }
  cache.projects ??= []
  return cache
}

export async function saveConfig(next: StoredConfig): Promise<ConfigView> {
  cache = next
  await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf-8')
  return toConfigView(next)
}

export function encryptApiKey(key: string): string {
  if (!key) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return ENCRYPTED_PREFIX + safeStorage.encryptString(key).toString('base64')
  }
  // 降级：明文存储但打上标记，之后可以做"提示用户风险"的 UI
  return PLAIN_PREFIX + key
}

export function decryptApiKey(stored: string): string {
  if (!stored) return ''
  if (stored.startsWith(ENCRYPTED_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64'))
    } catch {
      return '' // 解密失败（例如换了系统用户）当作未配置处理
    }
  }
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length)
  return stored
}

function maskKey(key: string): string {
  return key ? `••••${key.slice(-4)}` : ''
}

/** 内部配置 → 渲染进程可见视图（apiKey 掩码） */
export function toConfigView(cfg: StoredConfig): ConfigView {
  return {
    projects: cfg.projects,
    activeProjectId: cfg.activeProjectId,
    llm: cfg.llm
      ? {
          provider: cfg.llm.provider,
          name: cfg.llm.name,
          baseURL: cfg.llm.baseURL,
          model: cfg.llm.model,
          hasApiKey: Boolean(cfg.llm.apiKey),
          apiKeyHint: maskKey(decryptApiKey(cfg.llm.apiKey)),
        }
      : null,
  }
}

export function registerConfigHandlers(): void {
  ipcMain.handle('config:get', async (): Promise<ConfigView> => toConfigView(await loadConfig()))

  // 保存 LLM 配置；apiKey 留空且原来已保存过 key 时，保留旧 key
  ipcMain.handle('config:saveLlm', async (_e, input: LLMConfig & { apiKey?: string }): Promise<ConfigView> => {
    const cfg = await loadConfig()
    const keepOldKey = (!input.apiKey || !input.apiKey.trim()) && Boolean(cfg.llm)
    cfg.llm = {
      provider: input.provider,
      name: input.name.trim() || '默认配置',
      baseURL: input.baseURL.trim(),
      model: input.model.trim(),
      apiKey: keepOldKey ? (cfg.llm as { apiKey: string }).apiKey : encryptApiKey(input.apiKey?.trim() ?? ''),
    }
    return saveConfig(cfg)
  })
}
