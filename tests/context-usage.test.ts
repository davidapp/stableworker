import { describe, expect, it } from 'vitest'
import { sameModelProfile, selectContextExchange } from '../src/shared/contextUsage'
import type { DebugListItem, LLMProfileView } from '../src/shared/types'

const profile: LLMProfileView = { id: 'p1', name: 'DeepSeek', provider: 'openai-compatible', baseURL: 'https://api.deepseek.com/', model: 'deepseek-flash', proxyURL: '', hasApiKey: true, apiKeyHint: '••••' }
const exchange: DebugListItem = { id: 'd1', kind: 'chat', sessionId: 's1', profileId: 'p1', scope: 'main', round: 1, startedAt: 100, durationMs: 10, provider: profile.provider, model: profile.model, url: 'https://api.deepseek.com/chat/completions', status: 200, error: null, eventCount: 2, inputTokens: 19451, outputTokens: 88, contextTokens: 19451, breakdown: null, cost: null }

describe('scoped context usage', () => {
  it('ignores other sessions, profiles, models, subagents, endpoints, and unscoped legacy logs', () => {
    const newer = [
      { ...exchange, startedAt: 200, sessionId: 's2' },
      { ...exchange, startedAt: 201, profileId: 'p2' },
      { ...exchange, startedAt: 202, model: 'other' },
      { ...exchange, startedAt: 203, scope: 'subagent' as const },
      { ...exchange, startedAt: 204, url: 'https://api.deepseek.com/vendor/chat/completions' },
      { ...exchange, startedAt: 205, sessionId: undefined },
    ]
    expect(selectContextExchange([...newer, exchange], 's1', profile)?.id).toBe('d1')
    expect(selectContextExchange(newer, 's1', profile)).toBeNull()
  })
  it('selects latest matching completed usage even when log list is unsorted', () => {
    expect(selectContextExchange([exchange, { ...exchange, id: 'd2', startedAt: 300 }], 's1', profile)?.id).toBe('d2')
    expect(selectContextExchange([exchange], null, profile)).toBeNull()
  })
  it('a delayed profile refresh cannot match a new model, endpoint, protocol or manual capacity', () => {
    expect(sameModelProfile(profile, { ...profile, baseURL: 'https://api.deepseek.com' })).toBe(true)
    for (const change of [{ model: 'new' }, { baseURL: 'https://gateway.example.com/v1' }, { provider: 'anthropic' as const }, { contextWindowOverride: 64000 }]) {
      expect(sameModelProfile(profile, { ...profile, ...change })).toBe(false)
    }
  })
})
