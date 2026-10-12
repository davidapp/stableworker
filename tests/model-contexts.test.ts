import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMConfig } from '../src/shared/types'

const mock = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }))
vi.mock('undici', () => ({ fetch: mock.fetch, ProxyAgent: class { close = mock.close } }))
const profile: LLMConfig = { name: 'DeepSeek', provider: 'openai-compatible', baseURL: 'https://api.deepseek.com/', model: 'deepseek-flash', proxyURL: '' }
let mod: typeof import('../src/main/modelContexts')
let root: string
let path: string
beforeEach(async () => {
  vi.resetModules()
  mock.fetch.mockReset()
  root = await mkdtemp(join(tmpdir(), 'stableworker-context-'))
  path = join(root, 'model-contexts.json')
  mod = await import('../src/main/modelContexts')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function response(data: unknown): Response { return new Response(JSON.stringify(data), { status: 200 }) }

describe('model context metadata', () => {
  it('gets exact capacity by ID and keeps output limit separate', () => {
    expect(mod.parseModelContextMetadata({ data: [{ id: 'other', context_window: 999 }, { id: 'deepseek-flash', context_window: 1048576, max_output_tokens: 393216 }] }, profile.model))
      .toEqual({ contextWindow: 1048576, maxOutputTokens: 393216 })
    expect(mod.parseModelContextMetadata({ data: [{ id: profile.model, max_tokens: 393216 }] }, profile.model)).toBeNull()
  })
  it('accepts documented Claude and Kimi fields, rejects invalid or unrelated metadata', () => {
    expect(mod.parseModelContextMetadata({ data: [{ id: 'x', max_input_tokens: 200000, max_tokens: 64000 }] }, 'x')).toEqual({ contextWindow: 200000, maxOutputTokens: 64000 })
    expect(mod.parseModelContextMetadata({ data: [{ id: 'x', context_length: 1048576 }] }, 'x')).toEqual({ contextWindow: 1048576 })
    for (const value of [0, -1, 1.5, '1048576', null, Infinity, NaN]) {
      expect(mod.parseModelContextMetadata({ data: [{ id: 'x', context_window: value }] }, 'x')).toBeNull()
    }
    expect(mod.parseModelContextMetadata({ data: [{ id: 'other', context_window: 1048576 }] }, 'x')).toBeNull()
  })
  it('uses exact service/model identities, no family regex fallback', () => {
    expect(mod.resolveModelContext(profile)?.contextWindow).toBe(1048576)
    expect(mod.resolveModelContext({ ...profile, model: 'deepseek-unlisted' })).toBeNull()
    expect(mod.resolveModelContext({ ...profile, baseURL: 'https://gateway.example.com/v1' })).toBeNull()
    expect(mod.resolveModelContext({ ...profile, model: 'gpt-5' })).toBeNull()
    expect(mod.resolveModelContext({ ...profile, provider: 'openai-compatible', baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1' })?.contextWindow).toBe(1047576)
  })
  it('uses correct endpoints/auth and never permits credential redirects', async () => {
    expect(mod.modelMetadataRequest({ ...profile, provider: 'anthropic', baseURL: 'https://api.deepseek.com/anthropic' }, 'private')).toEqual({ url: 'https://api.deepseek.com/models', headers: { authorization: 'Bearer private' } })
    expect(mod.modelMetadataRequest({ ...profile, provider: 'anthropic', baseURL: 'https://api.anthropic.com' }, 'private')).toEqual({ url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': 'private', 'anthropic-version': '2023-06-01' } })
    await mod.initializeModelContexts(path)
    mock.fetch.mockResolvedValue(response({ data: [{ id: profile.model, context_window: 1048576 }] }))
    await mod.refreshModelContext(profile, 'private')
    expect(mock.fetch).toHaveBeenCalledWith('https://api.deepseek.com/models', expect.objectContaining({ redirect: 'error' }))
    expect(await readFile(path, 'utf-8')).not.toContain('private')
  })
  it('persists actual server capacity and restores it on restart', async () => {
    await mod.initializeModelContexts(path)
    mock.fetch.mockResolvedValue(response({ data: [{ id: profile.model, context_window: 1048576, max_output_tokens: 393216 }] }))
    expect((await mod.refreshModelContext(profile, 'private')).ok).toBe(true)
    expect(mod.resolveModelContext(profile)).toEqual(expect.objectContaining({ source: 'api', contextWindow: 1048576, sourceUrl: 'https://api.deepseek.com/models' }))
    vi.resetModules()
    const restored = await import('../src/main/modelContexts')
    await restored.initializeModelContexts(path)
    expect(restored.resolveModelContext(profile)?.source).toBe('api')
  })
  it('failed/missing metadata keeps a verified same-model value and leaves unknown models unknown', async () => {
    await mod.initializeModelContexts(path)
    mock.fetch.mockResolvedValue(new Response('', { status: 503 }))
    expect((await mod.refreshModelContext(profile, '')).ok).toBe(false)
    expect(mod.resolveModelContext(profile)?.contextWindow).toBe(1048576)
    mock.fetch.mockResolvedValue(response({ data: [{ id: 'custom', max_output_tokens: 128000 }] }))
    const unknown = { ...profile, model: 'custom', baseURL: 'https://custom.example.com/v1' }
    await mod.refreshModelContext(unknown, '')
    expect(mod.resolveModelContext(unknown)).toBeNull()
  })
  it('damaged cache is backed up and does not block startup', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(path, '{broken')
    await expect(mod.initializeModelContexts(path)).resolves.toBeUndefined()
    expect(mod.resolveModelContext(profile)?.contextWindow).toBe(1048576)
    expect((await readdir(root)).some((name) => name.startsWith('model-contexts.json.invalid-'))).toBe(true)
    expect(await readFile(path, 'utf-8')).toBe('{broken')
    warning.mockRestore()
  })
  it('an older copied official-docs entry cannot override updated builtin evidence', async () => {
    await writeFile(path, JSON.stringify({ version: 1, models: [{ ...profile, contextWindow: 32000, source: 'official-docs', sourceUrl: 'https://api-docs.deepseek.com/', checkedAt: '2024-01-01' }] }))
    await mod.initializeModelContexts(path)
    expect(mod.resolveModelContext(profile)?.contextWindow).toBe(1048576)
  })
  it('parallel refreshes of one identity issue one request and cached startup avoids another request', async () => {
    await mod.initializeModelContexts(path)
    mock.fetch.mockResolvedValue(response({ data: [{ id: profile.model, context_window: 1048576 }] }))
    await Promise.all([mod.refreshModelContext(profile, ''), mod.refreshModelContext(profile, '')])
    expect(mock.fetch).toHaveBeenCalledTimes(1)
    await mod.refreshModelContext(profile, '', false)
    expect(mock.fetch).toHaveBeenCalledTimes(1)
  })
})
