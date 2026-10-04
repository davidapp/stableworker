import { app, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { DEFAULT_HOLIDAYS } from './pricing'
import type { ApprovalMode, ConfigView, FeatureEntry, LLMConfig, ModelPricing, ProjectInfo } from '../shared/types'

/**
 * 全局配置存储。
 * 设计借鉴 Claude Code：
 * - 单一全局 JSON 文件 + 内存缓存（读走缓存、写全量覆盖）
 * - apiKey 用 Electron safeStorage 加密后落盘；系统不支持时降级为带标记的明文
 * - 对渲染进程只暴露 ConfigView（apiKey 掩码），密钥原文永远不出主进程
 * - LLM 配置是多配置档（llmProfiles + activeLlmId）；旧版单配置在加载时自动迁移
 * - modelPricing：各模型价格表（按模型名）；holidays：法定节假日；features：功能入口显隐
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

const APPROVAL_MODES: ApprovalMode[] = ['confirm', 'autoEdit', 'fullAccess']

/** 各模型家族的上下文窗口默认值（tokens）；未匹配的模型用 fallback */
const CONTEXT_LIMITS: { match: RegExp; limit: number }[] = [
  // DeepSeek V4 系列原生支持 1M 上下文（官方 API，无长上下文加价）
  { match: /deepseek/i, limit: 1_000_000 },
  { match: /glm/i, limit: 128_000 },
  { match: /kimi|moonshot/i, limit: 256_000 },
  { match: /claude/i, limit: 200_000 },
  { match: /gpt-5|gpt-4\.1|gpt-4o/i, limit: 128_000 },
]
const CONTEXT_LIMIT_FALLBACK = 32_000

export function defaultContextLimit(model: string): number {
  return CONTEXT_LIMITS.find((e) => e.match.test(model))?.limit ?? CONTEXT_LIMIT_FALLBACK
}

/** 一条 LLM 配置档的落盘形态（apiKey 为加密后字符串） */
type StoredProfile = LLMConfig & { id: string; apiKey: string }

/** 落盘的完整配置形态 */
interface StoredConfig {
  projects: ProjectInfo[]
  activeProjectId: string | null
  /** v0.3 起为多配置档；llm 是旧版单配置字段，加载时迁移进 llmProfiles 后删除 */
  llm?: (LLMConfig & { apiKey: string }) | null
  llmProfiles?: StoredProfile[]
  activeLlmId?: string | null
  approvalMode?: ApprovalMode
  modelPricing?: ModelPricing[]
  holidays?: string[]
  features?: FeatureEntry[]
  sidebarWidth?: number
  contextLimit?: number
  toolSwitches?: Record<string, boolean>
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
    cache = { projects: [], activeProjectId: null }
  }
  cache.projects ??= []

  // 旧版单配置 → 多配置档迁移（只在本字段不存在时执行一次，之后完全尊重用户编辑）
  if (cache.llmProfiles === undefined) {
    if (cache.llm) {
      const legacy = cache.llm
      cache.llmProfiles = [{ ...legacy, proxyURL: legacy.proxyURL ?? '', id: randomUUID() }]
      cache.activeLlmId = cache.llmProfiles[0].id
    } else {
      cache.llmProfiles = []
      cache.activeLlmId = null
    }
    delete cache.llm
  }
  cache.llmProfiles.forEach((p) => {
    p.proxyURL ??= ''
  })
  if (cache.activeLlmId === undefined) cache.activeLlmId = null
  if (cache.approvalMode === undefined) cache.approvalMode = 'confirm'
  if (cache.modelPricing === undefined) cache.modelPricing = DEFAULT_MODEL_PRICING
  if (cache.holidays === undefined) cache.holidays = DEFAULT_HOLIDAYS
  if (cache.features === undefined) cache.features = []
  if (cache.sidebarWidth === undefined) cache.sidebarWidth = 240
  cache.sidebarWidth = Math.min(480, Math.max(180, cache.sidebarWidth))
  // 上下文上限按当前激活模型给默认值；首次生成后固化（可在 config.json 手改）
  if (cache.contextLimit === undefined) {
    const model = cache.llmProfiles?.find((p) => p.id === cache?.activeLlmId)?.model ?? ''
    cache.contextLimit = defaultContextLimit(model)
  }
  if (cache.toolSwitches === undefined) cache.toolSwitches = {}
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
    llmProfiles: (cfg.llmProfiles ?? []).map((p) => ({
      id: p.id,
      provider: p.provider,
      name: p.name,
      baseURL: p.baseURL,
      model: p.model,
      proxyURL: p.proxyURL,
      hasApiKey: Boolean(p.apiKey),
      apiKeyHint: maskKey(decryptApiKey(p.apiKey)),
    })),
    activeLlmId: cfg.activeLlmId ?? null,
    approvalMode: cfg.approvalMode ?? 'confirm',
    modelPricing: cfg.modelPricing ?? [],
    holidays: cfg.holidays ?? [],
    features: cfg.features ?? [],
    sidebarWidth: cfg.sidebarWidth ?? 240,
    contextLimit: cfg.contextLimit ?? 0,
    toolSwitches: cfg.toolSwitches ?? {},
  }
}

export function registerConfigHandlers(): void {
  ipcMain.handle('config:get', async (): Promise<ConfigView> => toConfigView(await loadConfig()))

  // 新增或更新一条配置档；apiKey 留空且原来已保存过 key 时保留旧 key；新增即激活
  ipcMain.handle(
    'config:saveProfile',
    async (_e, input: LLMConfig & { id?: string; apiKey?: string }): Promise<ConfigView> => {
      const cfg = await loadConfig()
      cfg.llmProfiles ??= []
      if (input.id) {
        const p = cfg.llmProfiles.find((x) => x.id === input.id)
        if (!p) return toConfigView(cfg)
        const keepOldKey = (!input.apiKey || !input.apiKey.trim()) && Boolean(p.apiKey)
        p.provider = input.provider
        p.name = input.name.trim() || p.name
        p.baseURL = input.baseURL.trim()
        p.model = input.model.trim()
        p.proxyURL = input.proxyURL?.trim() ?? ''
        p.apiKey = keepOldKey ? p.apiKey : encryptApiKey(input.apiKey?.trim() ?? '')
      } else {
        cfg.llmProfiles.push({
          id: randomUUID(),
          provider: input.provider,
          name: input.name.trim() || '默认配置',
          baseURL: input.baseURL.trim(),
          model: input.model.trim(),
          proxyURL: input.proxyURL?.trim() ?? '',
          apiKey: encryptApiKey(input.apiKey?.trim() ?? ''),
        })
        cfg.activeLlmId = cfg.llmProfiles[cfg.llmProfiles.length - 1].id
      }
      return saveConfig(cfg)
    },
  )

  ipcMain.handle('config:deleteProfile', async (_e, id: string): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.llmProfiles = (cfg.llmProfiles ?? []).filter((p) => p.id !== id)
    if (cfg.activeLlmId === id) cfg.activeLlmId = cfg.llmProfiles[0]?.id ?? null
    return saveConfig(cfg)
  })

  ipcMain.handle('config:setActiveLlm', async (_e, id: string): Promise<ConfigView> => {
    const cfg = await loadConfig()
    if ((cfg.llmProfiles ?? []).some((p) => p.id === id)) cfg.activeLlmId = id
    return saveConfig(cfg)
  })

  ipcMain.handle('config:setApprovalMode', async (_e, mode: ApprovalMode): Promise<ConfigView> => {
    const cfg = await loadConfig()
    if (APPROVAL_MODES.includes(mode)) cfg.approvalMode = mode
    return saveConfig(cfg)
  })

  // 设置激活配置档的思考力度（写入该配置档，随请求发给模型）
  ipcMain.handle('config:setThinkingEffort', async (_e, effort: string): Promise<ConfigView> => {
    const cfg = await loadConfig()
    const p = cfg.llmProfiles?.find((x) => x.id === cfg.activeLlmId)
    if (p && ['off', 'low', 'medium', 'high'].includes(effort)) {
      p.thinkingEffort = effort as LLMConfig['thinkingEffort']
    }
    return saveConfig(cfg)
  })

  // 保存侧栏宽度（拖拽结束时调用）
  ipcMain.handle('config:setSidebarWidth', async (_e, width: number): Promise<ConfigView> => {
    const cfg = await loadConfig()
    if (typeof width === 'number' && Number.isFinite(width)) {
      cfg.sidebarWidth = Math.min(480, Math.max(180, Math.round(width)))
    }
    return saveConfig(cfg)
  })

  // 保存上下文窗口上限（tokens；0 = 未知）
  ipcMain.handle('config:setContextLimit', async (_e, limit: number): Promise<ConfigView> => {
    const cfg = await loadConfig()
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
      cfg.contextLimit = Math.round(limit)
    }
    return saveConfig(cfg)
  })

  // 设置工具开关（禁用的工具不会随请求发给模型）
  ipcMain.handle('config:setToolSwitch', async (_e, name: string, enabled: boolean): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.toolSwitches ??= {}
    cfg.toolSwitches[name] = enabled
    return saveConfig(cfg)
  })

  // 保存模型价格表（全局，按模型名；供调试面板精确计费）
  ipcMain.handle('config:savePricing', async (_e, pricing: ModelPricing[]): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.modelPricing = pricing
    return saveConfig(cfg)
  })

  // 保存节假日表（北京时间日期，供分时计费判定高峰/空闲）
  ipcMain.handle('config:saveHolidays', async (_e, holidays: string[]): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.holidays = holidays
    return saveConfig(cfg)
  })

  // 保存功能入口的显隐状态
  ipcMain.handle('config:saveFeatures', async (_e, features: FeatureEntry[]): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.features = features
    return saveConfig(cfg)
  })
}
