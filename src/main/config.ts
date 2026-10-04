import { app, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { DEFAULT_HOLIDAYS } from './pricing'
import type { ConfigView, LLMConfig, ModelPricing, ProjectInfo } from '../shared/types'

/**
 * 全局配置存储。
 * 设计借鉴 Claude Code：
 * - 单一全局 JSON 文件 + 内存缓存（读走缓存、写全量覆盖）
 * - apiKey 用 Electron safeStorage 加密后落盘；系统不支持时降级为带标记的明文
 * - 对渲染进程只暴露 ConfigView（apiKey 掩码），密钥原文永远不出主进程
 * - modelPricing：各模型价格表（按模型名），用于调试面板的精确计费
 * - holidays：中国法定节假日（北京时间日期），供高峰/空闲判定，可编辑
 */

const ENCRYPTED_PREFIX = 'enc:v1:'
const PLAIN_PREFIX = 'plain:'

/** 预置价格：DeepSeek deepseek-flash（人民币，2026-10 官方定价） */
const DEFAULT_MODEL_PRICING: ModelPricing[] = [
  {
    model: 'deepseek-flash',
    currency: 'CNY',
    inputCacheHitOffPeak: 0.02,
    inputCacheHitPeak: 0.04,
    inputCacheMissOffPeak: 1.0,
    inputCacheMissPeak: 2.0,
    outputOffPeak: 4.0,
    outputPeak: 8.0,
  },
]

/** 落盘的完整配置形态（含 apiKey 明文/密文） */
interface StoredConfig {
  projects: ProjectInfo[]
  activeProjectId: string | null
  llm: (LLMConfig & { apiKey: string }) | null
  modelPricing?: ModelPricing[]
  holidays?: string[]
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
  // 旧版本配置没有 proxyURL 字段，归一化成空串（= 直连）
  if (cache.llm) cache.llm.proxyURL ??= ''
  // 价格表 / 节假日首次使用时预置；字段一旦存在（哪怕为空数组）就完全尊重用户编辑
  if (cache.modelPricing === undefined) cache.modelPricing = DEFAULT_MODEL_PRICING
  if (cache.holidays === undefined) cache.holidays = DEFAULT_HOLIDAYS
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
    modelPricing: cfg.modelPricing ?? [],
    holidays: cfg.holidays ?? [],
    llm: cfg.llm
      ? {
          provider: cfg.llm.provider,
          name: cfg.llm.name,
          baseURL: cfg.llm.baseURL,
          model: cfg.llm.model,
          proxyURL: cfg.llm.proxyURL,
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
      proxyURL: input.proxyURL?.trim() ?? '',
      apiKey: keepOldKey ? (cfg.llm as { apiKey: string }).apiKey : encryptApiKey(input.apiKey?.trim() ?? ''),
    }
    return saveConfig(cfg)
  })

  // 保存模型价格表（全局，按模型名；供调试面板精确计费）
  ipcMain.handle('config:savePricing', async (_e, pricing: ModelPricing[]): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.modelPricing = pricing
    return saveConfig(cfg)
  })
}
