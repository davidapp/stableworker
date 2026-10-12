import type { DebugListItem, LLMConfig, LLMProfileView } from './types'

export function sameModelProfile(a: LLMConfig, b: LLMConfig): boolean {
  const base = (p: LLMConfig): string => p.baseURL.trim().replace(/\/+$/, '') ||
    (p.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
  return a.provider === b.provider && a.model.trim() === b.model.trim() && base(a) === base(b) &&
    (a.contextWindowOverride ?? 0) === (b.contextWindowOverride ?? 0)
}

/** Legacy unscoped logs cannot establish the current conversation's token usage. */
export function selectContextExchange(list: DebugListItem[], sessionId: string | null, profile: LLMProfileView | undefined): DebugListItem | null {
  if (!sessionId || !profile) return null
  const base = profile.baseURL.trim().replace(/\/+$/, '') ||
    (profile.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
  const endpoint = `${base}${profile.provider === 'anthropic' ? '/v1/messages' : '/chat/completions'}`
  return list.filter((item) => item.kind === 'chat' && item.scope === 'main' &&
    item.sessionId === sessionId && item.profileId === profile.id && item.model === profile.model &&
    item.provider === profile.provider && item.url === endpoint && item.inputTokens != null)
    .reduce<DebugListItem | null>((latest, item) => !latest || item.startedAt > latest.startedAt ? item : latest, null)
}
