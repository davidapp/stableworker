import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import type { Dispatcher } from 'undici'
import verified from '../../config/model-contexts.json'
import type { LLMConfig, ModelContextInfo, ProviderType } from '../shared/types'

interface CatalogEntry extends ModelContextInfo {
  provider: ProviderType
  baseURL: string
  model: string
}

const entries = new Map<string, CatalogEntry>()
const pending = new Map<string, Promise<ContextRefreshResult>>()
let catalogPath: string | null = null
let loading: Promise<void> | null = null
let writes = Promise.resolve()
const REFRESH_INTERVAL_MS = 60 * 60_000

export interface ContextRefreshResult {
  ok: boolean
  message: string
}

export function normalizeModelBaseURL(profile: Pick<LLMConfig, 'provider' | 'baseURL'>): string {
  const raw = profile.baseURL.trim() || (profile.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('模型服务地址必须使用 HTTP 或 HTTPS')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function identity(profile: Pick<LLMConfig, 'provider' | 'baseURL' | 'model'>): string {
  return JSON.stringify([profile.provider, normalizeModelBaseURL(profile), profile.model.trim()])
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<CatalogEntry>
  return (v.provider === 'openai-compatible' || v.provider === 'anthropic') &&
    typeof v.baseURL === 'string' && typeof v.model === 'string' && v.model.length > 0 &&
    positiveInteger(v.contextWindow) && typeof v.sourceUrl === 'string' && typeof v.checkedAt === 'string' &&
    (v.source === 'api' || v.source === 'official-docs' || v.source === 'manual') &&
    (v.maxOutputTokens === undefined || positiveInteger(v.maxOutputTokens))
}

for (const group of verified.models) {
  for (const provider of group.providers) for (const baseURL of group.baseURLs) for (const model of group.models) {
    const entry: CatalogEntry = {
      provider: provider as ProviderType, baseURL, model,
      contextWindow: group.contextWindow,
      ...('maxOutputTokens' in group ? { maxOutputTokens: group.maxOutputTokens } : {}),
      source: 'official-docs', sourceUrl: group.sourceUrl, checkedAt: group.checkedAt,
    }
    entries.set(identity(entry), entry)
  }
}

async function persist(): Promise<void> {
  if (!catalogPath) return
  const path = catalogPath
  const payload = JSON.stringify({ version: 1, models: [...entries.values()] }, null, 2)
  const operation = writes.catch(() => {}).then(async () => {
    const temp = `${path}.tmp`
    await writeFile(temp, payload, 'utf-8')
    await rename(temp, path)
  })
  writes = operation
  await operation
}

/** Load the editable, credential-free runtime catalog once before reading configuration. */
export function initializeModelContexts(path: string): Promise<void> {
  if (loading) return loading
  catalogPath = path
  loading = (async () => {
    try {
      const saved = JSON.parse(await readFile(path, 'utf-8')) as { version?: unknown; models?: unknown[] }
      if (saved.version !== 1 || !Array.isArray(saved.models)) throw new Error('模型容量配置格式无效')
      for (const entry of saved.models) {
        if (!validEntry(entry)) continue
        try {
          const key = identity(entry)
          const builtin = entries.get(key)
          if (entry.source === 'official-docs' && builtin?.source === 'official-docs' &&
              Date.parse(entry.checkedAt) < Date.parse(builtin.checkedAt)) continue
          entries.set(key, entry)
        } catch { /* Ignore invalid service URLs. */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await persist()
      } else {
        // A damaged metadata cache must not prevent opening conversations or settings.
        await copyFile(path, `${path}.invalid-${Date.now()}`).catch(() => {})
        console.warn('模型容量缓存不可读，已保留备份并采用已核实的内置配置')
      }
    }
  })()
  return loading
}

export function resolveModelContext(profile: LLMConfig | null | undefined): ModelContextInfo | null {
  if (!profile) return null
  if (positiveInteger(profile.contextWindowOverride)) {
    return { contextWindow: profile.contextWindowOverride, source: 'manual', sourceUrl: '', checkedAt: '' }
  }
  let entry: CatalogEntry | undefined
  try { entry = entries.get(identity(profile)) } catch { return null }
  if (!entry) return null
  return { contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens,
    source: entry.source, sourceUrl: entry.sourceUrl, checkedAt: entry.checkedAt }
}

/** Input capacity and output capacity are separate fields. Never use max_tokens as input capacity. */
export function parseModelContextMetadata(payload: unknown, model: string): Pick<ModelContextInfo, 'contextWindow' | 'maxOutputTokens'> | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const entry = data.find((v) => v && typeof v === 'object' && (v as { id?: unknown }).id === model.trim()) as Record<string, unknown> | undefined
  if (!entry) return null
  const contextWindow = [entry.context_window, entry.context_length, entry.max_input_tokens].find(positiveInteger)
  if (!positiveInteger(contextWindow)) return null
  const maxOutputTokens = [entry.max_output_tokens, entry.max_tokens].find(positiveInteger)
  return { contextWindow, ...(positiveInteger(maxOutputTokens) ? { maxOutputTokens } : {}) }
}

export function modelMetadataRequest(profile: LLMConfig, apiKey: string): { url: string; headers: Record<string, string> } {
  const base = normalizeModelBaseURL(profile)
  const url = new URL(base)
  // DeepSeek's documented model catalog uses Bearer auth at the root, including Anthropic clients.
  if (url.hostname === 'api.deepseek.com' && ['/anthropic', '/v1', ''].includes(url.pathname)) {
    return { url: `${url.origin}/models`, headers: { authorization: `Bearer ${apiKey}` } }
  }
  if (profile.provider === 'anthropic') {
    return { url: `${base.endsWith('/v1') ? base : `${base}/v1`}/models`, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } }
  }
  return { url: `${base}/models`, headers: { authorization: `Bearer ${apiKey}` } }
}

export async function refreshModelContext(profile: LLMConfig, apiKey: string, force = true): Promise<ContextRefreshResult> {
  let key: string
  try { key = identity(profile) } catch { return { ok: false, message: '模型服务地址无效' } }
  if (!profile.model.trim()) return { ok: false, message: '请先填写模型名称' }
  const cached = entries.get(key)
  if (!force && cached?.source === 'api' && Date.now() - Date.parse(cached.checkedAt) < REFRESH_INTERVAL_MS) {
    return { ok: true, message: '使用最近从服务获取的模型容量' }
  }
  const running = pending.get(key)
  if (running) return running
  const task = (async (): Promise<ContextRefreshResult> => {
    let proxy: ProxyAgent | undefined
    try {
      const request = modelMetadataRequest(profile, apiKey)
      if (profile.proxyURL.trim()) proxy = new ProxyAgent(profile.proxyURL.trim())
      const response = await undiciFetch(request.url, {
        headers: request.headers, redirect: 'error', signal: AbortSignal.timeout(12_000),
        ...(proxy ? { dispatcher: proxy as Dispatcher } : {}),
      })
      if (!response.ok) {
        await response.body?.cancel()
        return { ok: false, message: `模型元数据请求返回 HTTP ${response.status}；保留已验证的同模型容量` }
      }
      const metadata = parseModelContextMetadata(await response.json(), profile.model)
      if (!metadata) {
        return { ok: false, message: cached ? '服务未提供该模型的输入容量；继续使用已验证的配置，来源见容量详情' : '服务未提供该模型的输入容量，上限未确认' }
      }
      const candidate: CatalogEntry = { provider: profile.provider, baseURL: normalizeModelBaseURL(profile), model: profile.model.trim(),
        ...metadata, source: 'api', sourceUrl: request.url, checkedAt: new Date().toISOString() }
      entries.set(key, candidate)
      try { await persist() } catch (error) {
        if (entries.get(key) === candidate) {
          if (cached) entries.set(key, cached)
          else entries.delete(key)
        }
        throw error
      }
      return { ok: true, message: `已从服务获取上下文容量：${metadata.contextWindow.toLocaleString()} tokens` }
    } catch {
      return { ok: false, message: '获取或保存模型元数据失败；保留已验证的同模型容量' }
    } finally {
      if (proxy) await proxy.close().catch(() => {})
    }
  })()
  pending.set(key, task)
  try { return await task } finally { pending.delete(key) }
}
