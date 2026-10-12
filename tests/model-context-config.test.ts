import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigView, LLMConfig, ModelContextInfo } from '../src/shared/types'

type Handler = (_event: undefined, ...args: unknown[]) => unknown
type TestProfile = LLMConfig & { id: string; apiKey: string }
type ConfigFile = {
  contextLimit?: number
  legacyContextLimit?: number
  llmProfiles: TestProfile[]
  activeLlmId: string | null
}
type RefreshResponse = { ok: boolean; message: string; config: ConfigView }
type CatalogFile = {
  version: number
  models: (ModelContextInfo & Pick<LLMConfig, 'provider' | 'baseURL' | 'model'>)[]
}

const mocks = vi.hoisted(() => {
  const state = { userData: '' }
  const handlers = new Map<string, Handler>()
  return {
    state,
    handlers,
    getPath: vi.fn(() => state.userData),
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    fetch: vi.fn(),
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((key: string) => Buffer.from(key)),
    decryptString: vi.fn((key: Buffer) => key.toString()),
  }
})

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  ipcMain: { handle: mocks.handle },
  safeStorage: {
    isEncryptionAvailable: mocks.isEncryptionAvailable,
    encryptString: mocks.encryptString,
    decryptString: mocks.decryptString,
  },
}))
vi.mock('undici', () => ({ fetch: mocks.fetch, ProxyAgent: vi.fn() }))

function profile(id: string, changes: Partial<TestProfile> = {}): TestProfile {
  return {
    id,
    provider: 'openai-compatible',
    name: id,
    baseURL: 'https://api.deepseek.com/',
    model: 'deepseek-flash',
    proxyURL: '',
    apiKey: 'plain:fixture-api-key',
    ...changes,
  }
}

async function fixture(profiles: TestProfile[], activeLlmId = profiles[0]?.id ?? null, contextLimit?: number): Promise<void> {
  await writeFile(join(mocks.state.userData, 'config.json'), JSON.stringify({
    projects: [], activeProjectId: null, llmProfiles: profiles, activeLlmId,
    ...(contextLimit !== undefined ? { contextLimit } : {}),
  }), 'utf-8')
  const config = await import('../src/main/config')
  config.registerConfigHandlers()
}

async function invoke<T = ConfigView>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return await handler(undefined, ...args) as T
}

async function savedConfig(): Promise<ConfigFile> {
  return JSON.parse(await readFile(join(mocks.state.userData, 'config.json'), 'utf-8')) as ConfigFile
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.fetch.mockReset()
  mocks.state.userData = await mkdtemp(join(tmpdir(), 'stableworker-model-config-'))
})

afterEach(async () => {
  await rm(mocks.state.userData, { recursive: true, force: true })
})

describe('model context configuration through IPC', () => {
  it('replaces the old unscoped 32k limit with verified DeepSeek capacity and retains the legacy value for audit', async () => {
    await fixture([profile('deepseek')], 'deepseek', 32_000)

    const view = await invoke('config:get')
    expect(view.contextLimit).toBe(1_048_576)
    expect(view.contextInfo).toMatchObject({ contextWindow: 1_048_576, source: 'official-docs' })
    expect(view.llmProfiles[0].contextInfo).toEqual(view.contextInfo)
    expect(JSON.stringify(view)).not.toContain('fixture-api-key')

    await invoke('config:setActiveLlm', 'deepseek')
    expect(await savedConfig()).toMatchObject({ contextLimit: 1_048_576, legacyContextLimit: 32_000 })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('updates capacity when switching models and leaves an unrecognized exact model unknown', async () => {
    await fixture([
      profile('deepseek'),
      profile('gpt', { baseURL: 'https://api.openai.com/v1', model: 'gpt-5' }),
      profile('unknown', { baseURL: 'https://api.openai.com/v1', model: 'gpt-5-unverified' }),
    ])

    expect((await invoke('config:setActiveLlm', 'gpt')).contextLimit).toBe(400_000)
    const unknown = await invoke('config:setActiveLlm', 'unknown')
    expect(unknown).toMatchObject({ activeLlmId: 'unknown', contextLimit: 0, contextInfo: null })
    expect(unknown.llmProfiles.find((p) => p.id === 'unknown')?.contextInfo).toBeNull()
    expect(await savedConfig()).toMatchObject({ contextLimit: 0, activeLlmId: 'unknown' })
    expect((await invoke('config:setActiveLlm', 'deepseek')).contextLimit).toBe(1_048_576)
  })

  it('does not apply official capacity to a third-party endpoint using the same model name', async () => {
    await fixture([
      profile('official'),
      profile('relay', { baseURL: 'https://relay.example/v1' }),
    ], 'relay', 1_048_576)

    const relay = await invoke('config:get')
    expect(relay).toMatchObject({ contextLimit: 0, contextInfo: null })
    expect(relay.llmProfiles.find((p) => p.id === 'official')?.contextInfo?.contextWindow).toBe(1_048_576)
    expect((await invoke('config:setActiveLlm', 'official')).contextLimit).toBe(1_048_576)
  })

  it('recomputes capacity when saving a changed active profile and keeps the stored key when omitted', async () => {
    const original = profile('active')
    await fixture([original], 'active', 32_000)

    const edited = { ...original, apiKey: undefined, baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1' }
    const openai = await invoke('config:saveProfile', edited)
    expect(openai.contextLimit).toBe(1_047_576)
    expect((await savedConfig()).llmProfiles[0].apiKey).toBe('plain:fixture-api-key')

    const unknown = await invoke('config:saveProfile', { ...edited, model: 'custom-unverified' })
    expect(unknown).toMatchObject({ contextLimit: 0, contextInfo: null })
    expect((await savedConfig()).llmProfiles[0].model).toBe('custom-unverified')
  })

  it('persists a profile-specific manual override and clears it with zero in the profile editor', async () => {
    const official = profile('official')
    await fixture([official])

    const overridden = await invoke('config:saveProfile', { ...official, apiKey: undefined, contextWindowOverride: 64_000 })
    expect(overridden).toMatchObject({ contextLimit: 64_000, contextInfo: { source: 'manual' } })
    expect((await savedConfig()).llmProfiles[0].contextWindowOverride).toBe(64_000)

    const automatic = await invoke('config:saveProfile', { ...official, apiKey: undefined, contextWindowOverride: 0 })
    expect(automatic.contextLimit).toBe(1_048_576)
    expect(automatic.contextInfo?.source).toBe('official-docs')
    expect((await savedConfig()).llmProfiles[0]).not.toHaveProperty('contextWindowOverride')
  })

  it('scopes the legacy override handler to the active profile and returns an unknown model to unknown after clearing', async () => {
    await fixture([
      profile('unknown', { baseURL: 'https://relay.example/v1', model: 'custom' }),
      profile('gpt', { baseURL: 'https://api.openai.com/v1', model: 'gpt-5' }),
    ])

    expect((await invoke('config:setContextLimit', 160_000)).contextInfo?.source).toBe('manual')
    expect((await invoke('config:setActiveLlm', 'gpt')).contextLimit).toBe(400_000)
    expect((await invoke('config:setActiveLlm', 'unknown')).contextLimit).toBe(160_000)
    expect(await invoke('config:setContextLimit', 0)).toMatchObject({ contextLimit: 0, contextInfo: null })
    const saved = await savedConfig()
    expect(saved.llmProfiles.every((p) => p.contextWindowOverride === undefined)).toBe(true)
  })

  it('refreshes real metadata, updates the returned view, and restores the credential-free catalog after restart', async () => {
    const target = profile('active', { baseURL: 'https://relay.example/v1', model: 'custom' })
    await fixture([target])
    expect((await invoke('config:get')).contextLimit).toBe(0)
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ object: 'list', data: [{ id: 'custom', context_window: 222_222, max_output_tokens: 8_192 }] }),
    })

    const refreshed = await invoke<RefreshResponse>('config:refreshModelContext')
    expect(refreshed.ok).toBe(true)
    expect(refreshed.config.contextLimit).toBe(222_222)
    expect(refreshed.config.contextInfo).toMatchObject({
      contextWindow: 222_222, maxOutputTokens: 8_192, source: 'api', sourceUrl: 'https://relay.example/v1/models',
    })
    expect(mocks.fetch).toHaveBeenCalledWith('https://relay.example/v1/models', expect.objectContaining({
      headers: { authorization: 'Bearer fixture-api-key' }, redirect: 'error',
    }))
    expect((await savedConfig()).contextLimit).toBe(222_222)

    const catalogText = await readFile(join(mocks.state.userData, 'model-contexts.json'), 'utf-8')
    const catalog = JSON.parse(catalogText) as CatalogFile
    expect(catalog.version).toBe(1)
    expect(catalog.models.find((m) => m.baseURL === 'https://relay.example/v1' && m.model === 'custom')).toMatchObject({
      provider: 'openai-compatible', contextWindow: 222_222, source: 'api',
    })
    expect(catalogText).not.toContain('fixture-api-key')
    expect(catalogText).not.toContain('authorization')

    vi.resetModules()
    const restarted = await import('../src/main/config')
    restarted.registerConfigHandlers()
    const restored = await invoke('config:get')
    expect(restored.contextLimit).toBe(222_222)
    expect(restored.contextInfo).toEqual(refreshed.config.contextInfo)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('refreshes an inactive profile without changing the active model capacity', async () => {
    await fixture([
      profile('official'),
      profile('relay', { baseURL: 'https://relay.example/v1', model: 'custom' }),
    ])
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'custom', context_length: 90_000 }] }),
    })

    const refreshed = await invoke<RefreshResponse>('config:refreshModelContext', 'relay')
    expect(refreshed.ok).toBe(true)
    expect(refreshed.config).toMatchObject({ activeLlmId: 'official', contextLimit: 1_048_576 })
    expect(refreshed.config.llmProfiles.find((p) => p.id === 'relay')?.contextInfo).toMatchObject({ contextWindow: 90_000, source: 'api' })
    expect((await invoke('config:setActiveLlm', 'relay')).contextLimit).toBe(90_000)
  })
})
