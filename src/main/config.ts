import { app, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { DEFAULT_HOLIDAYS } from './pricing'
import { approveAllPending } from './approvals'
import { initializeModelContexts, refreshModelContext, resolveModelContext } from './modelContexts'
import { BrowserWindow, nativeTheme } from 'electron'
import type { ApprovalMode, ConfigView, HookConfig, LLMConfig, MCPServerConfig, MediaCapability, ModelPricing, PermissionRules, ProjectInfo, Preferences, SubagentTypeConfig } from '../shared/types'

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

const APPROVAL_MODES: ApprovalMode[] = ['plan', 'confirm', 'autoEdit', 'fullAccess']

/** 三项关键设置的有效值（项目覆盖 > 全局；permissionRules 与全局按 deny/ask/allow 分别合并） */
export function resolveEffectiveSettings(
  cfg: Pick<StoredConfig, 'toolSwitches' | 'officeToolSwitches' | 'videoToolSwitches' | 'approvalMode' | 'permissionRules'>,
  mode: 'coding' | 'office' | 'video' = 'coding',
): { toolSwitches: Record<string, boolean>; approvalMode: ApprovalMode; permissionRules: PermissionRules } {
  return {
    approvalMode: cfg.approvalMode ?? 'confirm',
    toolSwitches: mode === 'office' ? cfg.officeToolSwitches ?? {} : mode === 'video' ? cfg.videoToolSwitches ?? {} : cfg.toolSwitches ?? {},
    permissionRules: cfg.permissionRules ?? { allow: [], ask: [], deny: [] },
  }
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
  sidebarWidth?: number
  contextLimit?: number
  /** Old unscoped limit retained for migration/auditing, never used as verified model capacity. */
  legacyContextLimit?: number
  toolSwitches?: Record<string, boolean>
  /** 办公模式的工具开关（独立于编程模式） */
  officeToolSwitches?: Record<string, boolean>
  /** 视频模式的工具开关（独立于编程/办公模式） */
  videoToolSwitches?: Record<string, boolean>
  permissionRules?: PermissionRules
  mcpServers?: MCPServerConfig[]
  sidebarExpanded?: Record<string, boolean>
  subagentTypes?: SubagentTypeConfig[]
  hooks?: HookConfig[]
  preferences?: Partial<Preferences>
  microCompactRatio?: number
  /** 媒体能力 API 配置（apiKey 加密落盘） */
  mediaApis?: Partial<Record<MediaCapability, { baseUrl: string; model: string; apiKey: string }>>
  microCompactKeep?: number
}

let cache: StoredConfig | null = null
/** 实时批准模式：工具门禁每步直接读取，切换模式立即生效（不等下一轮对话重新 loadConfig） */
let liveApprovalMode: ApprovalMode = 'confirm'

function syncLiveApprovalMode(cfg: StoredConfig): void {
  liveApprovalMode = cfg.approvalMode ?? 'confirm'
}

/** 门禁读取当前批准模式（实时值） */
export function getApprovalMode(): ApprovalMode {
  return liveApprovalMode
}

/** 显式设置实时批准模式（loadConfig/saveConfig 内部同步；测试可直接调用） */
export function setLiveApprovalMode(mode: ApprovalMode): void {
  liveApprovalMode = mode
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function updateContextLimit(cfg: StoredConfig): void {
  const profile = cfg.llmProfiles?.find((p) => p.id === cfg.activeLlmId)
  cfg.contextLimit = resolveModelContext(profile)?.contextWindow ?? 0
}

export async function loadConfig(): Promise<StoredConfig> {
  await initializeModelContexts(join(app.getPath('userData'), 'model-contexts.json'))
  if (cache) {
    updateContextLimit(cache)
    return cache
  }
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
    p.enabled ??= true
  })
  if (cache.activeLlmId === undefined) cache.activeLlmId = null
  if (cache.approvalMode === undefined) cache.approvalMode = 'confirm'
  if (cache.modelPricing === undefined) cache.modelPricing = DEFAULT_MODEL_PRICING
  if (cache.holidays === undefined) cache.holidays = DEFAULT_HOLIDAYS
  if (cache.sidebarWidth === undefined) cache.sidebarWidth = 240
  cache.sidebarWidth = Math.min(480, Math.max(180, cache.sidebarWidth))
  // The old global value may have been initialized before any model existed.
  // Preserve it for audit only; real capacity is resolved by service + exact model.
  if (cache.contextLimit !== undefined && cache.legacyContextLimit === undefined) {
    cache.legacyContextLimit = cache.contextLimit
  }
  updateContextLimit(cache)
  if (cache.toolSwitches === undefined) cache.toolSwitches = {}
  if (cache.officeToolSwitches === undefined) cache.officeToolSwitches = {}
  if (cache.videoToolSwitches === undefined) cache.videoToolSwitches = {}
  if (cache.permissionRules === undefined) cache.permissionRules = { allow: [], ask: [], deny: [] }
  if (cache.mcpServers === undefined) cache.mcpServers = []
  if (cache.sidebarExpanded === undefined) cache.sidebarExpanded = {}
  if (cache.subagentTypes === undefined) cache.subagentTypes = []
  if (cache.hooks === undefined) cache.hooks = []
  if (cache.microCompactRatio === undefined) cache.microCompactRatio = 0.55
  if (cache.microCompactKeep === undefined) cache.microCompactKeep = 2
  syncLiveApprovalMode(cache)
  return cache
}

export async function saveConfig(next: StoredConfig): Promise<ConfigView> {
  updateContextLimit(next)
  cache = next
  syncLiveApprovalMode(next)
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
      enabled: p.enabled !== false,
      thinkingEffort: p.thinkingEffort,
      contextWindowOverride: p.contextWindowOverride,
      contextInfo: resolveModelContext(p),
      hasApiKey: Boolean(p.apiKey),
      apiKeyHint: maskKey(decryptApiKey(p.apiKey)),
    })),
    activeLlmId: cfg.activeLlmId ?? null,
    mediaApis: Object.fromEntries(
      Object.entries(cfg.mediaApis ?? {}).map(([capability, v]) => [capability, {
        baseUrl: v.baseUrl,
        model: v.model,
        hasApiKey: Boolean(v.apiKey),
        apiKeyHint: maskKey(decryptApiKey(v.apiKey)),
      }]),
    ),
    approvalMode: cfg.approvalMode ?? 'confirm',
    modelPricing: cfg.modelPricing ?? [],
    holidays: cfg.holidays ?? [],
    sidebarWidth: cfg.sidebarWidth ?? 240,
    contextLimit: resolveModelContext(cfg.llmProfiles?.find((p) => p.id === cfg.activeLlmId))?.contextWindow ?? 0,
    contextInfo: resolveModelContext(cfg.llmProfiles?.find((p) => p.id === cfg.activeLlmId)),
    toolSwitches: cfg.toolSwitches ?? {},
    officeToolSwitches: cfg.officeToolSwitches ?? {},
    videoToolSwitches: cfg.videoToolSwitches ?? {},
    permissionRules: cfg.permissionRules ?? { allow: [], ask: [], deny: [] },
    mcpServers: cfg.mcpServers ?? [],
    sidebarExpanded: cfg.sidebarExpanded ?? {},
    subagentTypes: cfg.subagentTypes ?? [],
    hooks: cfg.hooks ?? [],
    preferences: {
      language: cfg.preferences?.language ?? 'zh',
      theme: cfg.preferences?.theme ?? 'dark',
      officePanelCollapsed: cfg.preferences?.officePanelCollapsed === true,
      filesPanelCollapsed: cfg.preferences?.filesPanelCollapsed === true,
    },
    microCompactRatio: cfg.microCompactRatio ?? 0.55,
    microCompactKeep: cfg.microCompactKeep ?? 2,
  }
}

/** 把最新配置视图广播给全部窗口（主进程改动批准模式等设置后调用，渲染端菜单即时同步） */
export function broadcastConfigUpdate(cfg: StoredConfig): void {
  const view = toConfigView(cfg)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('config:updated', view)
  }
}

export function registerConfigHandlers(): void {
  ipcMain.handle('config:get', async (): Promise<ConfigView> => toConfigView(await loadConfig()))

  ipcMain.handle('config:refreshModelContext', async (_e, id?: string, force = true) => {
    const cfg = await loadConfig()
    const profile = cfg.llmProfiles?.find((p) => p.id === (id ?? cfg.activeLlmId))
    if (!profile) return { ok: false, message: '请先配置模型', config: toConfigView(cfg) }
    const result = await refreshModelContext({ ...profile }, decryptApiKey(profile.apiKey), force)
    return { ...result, config: await saveConfig(await loadConfig()) }
  })

  // 新增或更新一条配置档；apiKey 留空且原来已保存过 key 时保留旧 key；新增即激活
  ipcMain.handle(
    'config:saveProfile',
    async (_e, input: LLMConfig & { id?: string; apiKey?: string }): Promise<ConfigView> => {
      const cfg = await loadConfig()
      cfg.llmProfiles ??= []
      if (input.contextWindowOverride !== undefined &&
          (!Number.isSafeInteger(input.contextWindowOverride) || input.contextWindowOverride < 0)) {
        throw new Error('上下文容量必须是非负整数；0 表示自动获取')
      }
      if (input.id) {
        const p = cfg.llmProfiles.find((x) => x.id === input.id)
        if (!p) return toConfigView(cfg)
        const keepOldKey = (!input.apiKey || !input.apiKey.trim()) && Boolean(p.apiKey)
        p.provider = input.provider
        p.name = input.name.trim() || p.name
        p.baseURL = input.baseURL.trim()
        p.model = input.model.trim()
        if (input.contextWindowOverride !== undefined) p.contextWindowOverride = input.contextWindowOverride || undefined
        p.proxyURL = input.proxyURL?.trim() ?? ''
        p.apiKey = keepOldKey ? p.apiKey : encryptApiKey(input.apiKey?.trim() ?? '')
      } else {
        cfg.llmProfiles.push({
          id: randomUUID(),
          provider: input.provider,
          name: input.name.trim() || '默认配置',
          baseURL: input.baseURL.trim(),
          model: input.model.trim(),
          contextWindowOverride: input.contextWindowOverride || undefined,
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

  ipcMain.handle(
    'config:setMicroCompact',
    async (_e, ratio: number, keep: number): Promise<ConfigView> => {
      const cfg = await loadConfig()
      if (typeof ratio === 'number' && Number.isFinite(ratio)) {
        cfg.microCompactRatio = Math.min(0.8, Math.max(0.3, ratio))
      }
      if (typeof keep === 'number' && Number.isFinite(keep)) {
        cfg.microCompactKeep = Math.min(6, Math.max(1, Math.round(keep)))
      }
      return saveConfig(cfg)
    },
  )

  const MEDIA_CAPABILITIES: MediaCapability[] = ['textToImage', 'imageToImage', 'textToAudio', 'speechRecognition', 'textToVideo', 'imageToVideo']

  // 保存单个媒体能力的 API 调用配置；keepApiKey 时沿用已存的密钥（输入框留空 = 不改密钥）
  ipcMain.handle(
    'config:saveMediaApi',
    async (_e, capability: MediaCapability, input: { baseUrl?: string; model?: string; apiKey?: string; keepApiKey?: boolean }): Promise<ConfigView> => {
      if (!MEDIA_CAPABILITIES.includes(capability)) throw new Error(`未知的媒体能力：${capability}`)
      const cfg = await loadConfig()
      cfg.mediaApis ??= {}
      const prev = cfg.mediaApis[capability]
      const newKey = input.apiKey?.trim()
      cfg.mediaApis[capability] = {
        baseUrl: input.baseUrl?.trim() ?? '',
        model: input.model?.trim() ?? '',
        apiKey: input.keepApiKey || !newKey ? (prev?.apiKey ?? '') : encryptApiKey(newKey),
      }
      return saveConfig(cfg)
    },
  )

  ipcMain.handle('config:clearMediaApi', async (_e, capability: MediaCapability): Promise<ConfigView> => {
    if (!MEDIA_CAPABILITIES.includes(capability)) throw new Error(`未知的媒体能力：${capability}`)
    const cfg = await loadConfig()
    if (cfg.mediaApis) delete cfg.mediaApis[capability]
    return saveConfig(cfg)
  })

  ipcMain.handle('config:setProfileEnabled', async (_e, id: string, enabled: boolean): Promise<ConfigView> => {
    const cfg = await loadConfig()
    const target = (cfg.llmProfiles ?? []).find((p) => p.id === id)
    if (!target) return toConfigView(cfg)
    target.enabled = enabled
    if (!enabled && cfg.activeLlmId === id) {
      const next = (cfg.llmProfiles ?? []).find((p) => p.id !== id && p.enabled !== false)
      cfg.activeLlmId = next?.id ?? null
    }
    if (enabled && !cfg.activeLlmId) cfg.activeLlmId = id
    return saveConfig(cfg)
  })

  ipcMain.handle('config:setActiveLlm', async (_e, id: string): Promise<ConfigView> => {
    const cfg = await loadConfig()
    if ((cfg.llmProfiles ?? []).some((p) => p.id === id)) cfg.activeLlmId = id
    return saveConfig(cfg)
  })

  ipcMain.handle('config:setApprovalMode', async (_e, mode: ApprovalMode): Promise<ConfigView> => {
    const cfg = await loadConfig()
    if (APPROVAL_MODES.includes(mode)) {
      cfg.approvalMode = mode
      liveApprovalMode = mode
      // 切到完全访问时，立即放行全部挂起中的批准请求（不等用户逐个点击）
      if (mode === 'fullAccess') {
        const n = approveAllPending()
        if (n > 0) console.info(`[approval] 完全访问：已自动放行 ${n} 个挂起请求`)
      }
    }
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

  // 设置工具开关（禁用的工具不会随请求发给模型）
  ipcMain.handle('config:setToolSwitch', async (_e, name: string, enabled: boolean, mode: 'coding' | 'office' | 'video' = 'coding'): Promise<ConfigView> => {
    const cfg = await loadConfig()
    const bucket = mode === 'office' ? (cfg.officeToolSwitches ??= {}) : mode === 'video' ? (cfg.videoToolSwitches ??= {}) : (cfg.toolSwitches ??= {})
    bucket[name] = enabled
    return saveConfig(cfg)
  })

  // 侧栏项目节点的展开状态（整体替换，渲染端每次折叠/展开都全量回写）
  ipcMain.handle('config:setSidebarExpanded', async (_e, map: Record<string, boolean>): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.sidebarExpanded = map && typeof map === 'object' ? map : {}
    return saveConfig(cfg)
  })

  // 自定义子代理类型（整体替换；名称校验 + 不与内置类型冲突）
  ipcMain.handle('config:setSubagentTypes', async (_e, list: SubagentTypeConfig[]): Promise<ConfigView> => {
    const cfg = await loadConfig()
    const BUILT_IN = new Set(['general-purpose', 'Explore'])
    const seen = new Set<string>()
    const clean = (Array.isArray(list) ? list : [])
      .map((t) => ({
        name: String(t.name ?? '').trim(),
        description: String(t.description ?? '').trim(),
        tools: t.tools === 'read-only' ? ('read-only' as const) : ('all' as const),
        prompt: String(t.prompt ?? ''),
      }))
      .filter((t) => /^[A-Za-z0-9_-]+$/.test(t.name) && !BUILT_IN.has(t.name) && !seen.has(t.name) && seen.add(t.name))
    cfg.subagentTypes = clean
    return saveConfig(cfg)
  })

  // Hooks 生命周期钩子（整体替换；必须有合法事件类型与命令行，id 缺失则补）
  ipcMain.handle('config:setHooks', async (_e, list: HookConfig[]): Promise<ConfigView> => {
    const cfg = await loadConfig()
    const EVENTS = new Set(['preToolUse', 'postToolUse', 'stop'])
    const clean = (Array.isArray(list) ? list : [])
      .map((h) => ({
        id: String(h.id ?? '').trim() || randomUUID(),
        event: h.event as HookConfig['event'],
        matcher: String(h.matcher ?? '').trim(),
        command: String(h.command ?? '').trim(),
        timeoutMs: typeof h.timeoutMs === 'number' && Number.isFinite(h.timeoutMs) && h.timeoutMs > 0 ? Math.round(h.timeoutMs) : undefined,
        disabled: h.disabled === true,
      }))
      .filter((h) => EVENTS.has(h.event) && h.command)
    cfg.hooks = clean
    return saveConfig(cfg)
  })

  // 界面偏好（局部合并）；主题切换同步原生主题（对话框 / 原生滚动条跟随）
  ipcMain.handle(
    'config:setPreferences',
    async (_e, patch: Partial<Preferences>): Promise<ConfigView> => {
      const cfg = await loadConfig()
      const language: Preferences['language'] = patch.language === 'en' ? 'en' : 'zh'
      const theme: Preferences['theme'] = patch.theme === 'light' ? 'light' : patch.theme === 'dark' ? 'dark' : 'dark'
      const officePanelCollapsed =
        typeof patch.officePanelCollapsed === 'boolean' ? patch.officePanelCollapsed : cfg.preferences?.officePanelCollapsed ?? false
      const filesPanelCollapsed =
        typeof patch.filesPanelCollapsed === 'boolean' ? patch.filesPanelCollapsed : cfg.preferences?.filesPanelCollapsed ?? false
      cfg.preferences = { language, theme, officePanelCollapsed, filesPanelCollapsed }
      nativeTheme.themeSource = theme
      return saveConfig(cfg)
    },
  )

  // Explicit capacity override belongs to the active profile; 0 returns to verified metadata.
  ipcMain.handle('config:setContextLimit', async (_e, limit: number): Promise<ConfigView> => {
    const cfg = await loadConfig()
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
      const profile = cfg.llmProfiles?.find((p) => p.id === cfg.activeLlmId)
      if (profile && Number.isSafeInteger(limit)) profile.contextWindowOverride = limit || undefined
    }
    return saveConfig(cfg)
  })

  // 保存权限规则（deny > ask > allow 整体替换）
  ipcMain.handle('config:setPermissionRules', async (_e, rules: PermissionRules): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.permissionRules = {
      allow: (rules.allow ?? []).map((s) => s.trim()).filter(Boolean),
      ask: (rules.ask ?? []).map((s) => s.trim()).filter(Boolean),
      deny: (rules.deny ?? []).map((s) => s.trim()).filter(Boolean),
    }
    return saveConfig(cfg)
  })

  // 追加一条 allow 规则（批准卡片"不再询问"用），去重
  ipcMain.handle('config:addPermissionRule', async (_e, rule: string): Promise<ConfigView> => {
    const cfg = await loadConfig()
    cfg.permissionRules ??= { allow: [], ask: [], deny: [] }
    const r = rule.trim()
    if (r && !cfg.permissionRules.allow.includes(r)) cfg.permissionRules.allow.push(r)
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

}
