import type { DebugListItem, LLMConfig, LLMProfileView, ProviderType } from './types'

export function defaultBaseURLForProvider(provider: ProviderType): string {
  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com'
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta'
    case 'ollama':
      return 'http://localhost:11434'
    case 'cohere':
      return 'https://api.cohere.com/v2'
    case 'azure-openai':
    case 'openai-responses':
    case 'openai-compatible':
    default:
      return 'https://api.openai.com/v1'
  }
}

export function chatEndpointForProfile(
  profile: Pick<LLMConfig, 'provider' | 'baseURL' | 'model'>,
  stream = true,
): string {
  const base = profile.baseURL.trim().replace(/\/+$/, '') || defaultBaseURLForProvider(profile.provider)
  switch (profile.provider) {
    case 'anthropic':
      return `${base.endsWith('/v1') ? base : `${base}/v1`}/messages`
    case 'openai-responses':
      return base.endsWith('/responses') ? base : `${base}/responses`
    case 'gemini': {
      const m = profile.model.trim().replace(/^models\//, '')
      const vBase = /\/v1(beta|alpha)?$/.test(base) ? base : `${base}/v1beta`
      return `${vBase}/models/${encodeURIComponent(m)}${stream ? ':streamGenerateContent?alt=sse' : ':generateContent'}`
    }
    case 'azure-openai': {
      if (base.includes('/chat/completions')) {
        return base.includes('api-version=') ? base : `${base}${base.includes('?') ? '&' : '?'}api-version=2025-01-01-preview`
      }
      if (base.endsWith('/openai/v1')) return `${base}/chat/completions`
      const root = base.replace(/\/openai(\/deployments\/.*)?$/, '')
      return `${root}/openai/deployments/${encodeURIComponent(profile.model.trim())}/chat/completions?api-version=2025-01-01-preview`
    }
    case 'ollama': {
      const root = base.replace(/\/(v1|api)$/, '')
      return `${root}/api/chat`
    }
    case 'cohere': {
      const vBase = /\/v[12]$/.test(base) ? base : `${base}/v2`
      return `${vBase}/chat`
    }
    case 'openai-compatible':
    default:
      return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  }
}

export function sameModelProfile(a: LLMConfig, b: LLMConfig): boolean {
  const base = (p: LLMConfig): string => p.baseURL.trim().replace(/\/+$/, '') || defaultBaseURLForProvider(p.provider)
  return a.provider === b.provider && a.model.trim() === b.model.trim() && base(a) === base(b) &&
    (a.contextWindowOverride ?? 0) === (b.contextWindowOverride ?? 0)
}

/** Legacy unscoped logs cannot establish the current conversation's token usage. */
export function selectContextExchange(list: DebugListItem[], sessionId: string | null, profile: LLMProfileView | undefined): DebugListItem | null {
  if (!sessionId || !profile) return null
  const endpoint = chatEndpointForProfile(profile, true)
  return list.filter((item) => item.kind === 'chat' && item.scope === 'main' &&
    item.sessionId === sessionId && item.profileId === profile.id && item.model === profile.model &&
    item.provider === profile.provider && item.url === endpoint && item.inputTokens != null)
    .reduce<DebugListItem | null>((latest, item) => !latest || item.startedAt > latest.startedAt ? item : latest, null)
}
