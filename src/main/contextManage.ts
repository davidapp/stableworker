import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { loadConfig, decryptApiKey } from './config'
import { getProxyDispatcher } from './llm'
import { appendSummaryLine, loadSessionAny, saveSessionInternal } from './sessions'
import { summarizeWithModel, invalidateCompactCache, setCachedCompact } from './compact'
import { estimateTokens } from '../shared/tokens'
import type { ChatMessage, ContextInfo, ContextOpResult, LLMConfig } from '../shared/types'

/**
 * 上下文管理（聊天右上角面板的后端）：
 * - getInfo：消息数 / token 估算 / 当前生效摘要
 * - saveSummary：编辑或新建摘要（追加 summary 行，覆盖旧摘要）
 * - deleteSummary：删除摘要（追加空 tombstone 行，缓存失效）
 * - compactNow：手动把全部历史压缩成一份摘要（"软清空"：界面保留，请求只发摘要）
 */

async function activeLlmOf(): Promise<{ llm: LLMConfig & { apiKey: string }; apiKey: string } | { error: string }> {
  const cfg = await loadConfig()
  const llm = cfg.llmProfiles?.find((p) => p.id === cfg.activeLlmId) ?? cfg.llmProfiles?.[0] ?? null
  if (!llm) return { error: '尚未配置 LLM API' }
  const apiKey = decryptApiKey(llm.apiKey)
  if (!apiKey) return { error: '当前配置档的 API Key 为空' }
  return { llm, apiKey }
}

export function registerContextHandlers(): void {
  ipcMain.handle(
    'context:getInfo',
    async (_e, projectId: string, sessionId: string): Promise<ContextInfo> => {
      const r = await loadSessionAny(projectId, sessionId)
      const session = r.session
      if (!session) return { messageCount: 0, tokensEstimate: 0, summary: null }
      const tokensEstimate = session.messages.reduce(
        (acc, m) =>
          acc +
          m.blocks.reduce((a, b) => {
            if (b.type === 'text' || b.type === 'reasoning') return a + estimateTokens(b.text)
            return a + estimateTokens(b.name + JSON.stringify(b.input) + (b.result ?? ''))
          }, 0),
        0,
      )
      return { messageCount: session.messages.length, tokensEstimate, summary: session.summary ?? null }
    },
  )

  // 保存（编辑 / 新建）摘要：追加一条 summary 行覆盖旧摘要
  ipcMain.handle(
    'context:saveSummary',
    async (_e, projectId: string, sessionId: string, text: string): Promise<ContextOpResult> => {
      const trimmed = text.trim()
      if (!trimmed) return { ok: false, error: '摘要内容不能为空（删除摘要请用"删除摘要"按钮）' }
      const r = await loadSessionAny(projectId, sessionId)
      const messageCount = r.session?.messages.length ?? 0
      // 编辑已有摘要保持其覆盖范围不变；新建摘要默认覆盖全部消息
      const droppedCount = r.session?.summary?.droppedCount ?? messageCount
      await appendSummaryLine(projectId, sessionId, droppedCount, trimmed)
      setCachedCompact(sessionId, droppedCount, trimmed)
      return { ok: true }
    },
  )

  // 删除摘要：追加 tombstone 行并使缓存失效
  ipcMain.handle(
    'context:deleteSummary',
    async (_e, projectId: string, sessionId: string): Promise<ContextOpResult> => {
      await appendSummaryLine(projectId, sessionId, 0, '')
      setCachedCompact(sessionId, 0, '')
      return { ok: true }
    },
  )

  // 手动压缩：把当前全部历史压缩成一份摘要（界面保留，请求此后只发摘要）
  ipcMain.handle(
    'context:compactNow',
    async (_e, projectId: string, sessionId: string): Promise<ContextOpResult> => {
      const llmOf = await activeLlmOf()
      if ('error' in llmOf) return { ok: false, error: llmOf.error }
      const r = await loadSessionAny(projectId, sessionId)
      if (!r.session || r.session.messages.length === 0) return { ok: false, error: '会话没有可压缩的消息' }
      try {
        const summary = await summarizeWithModel({
          llm: llmOf.llm,
          apiKey: llmOf.apiKey,
          dispatcher: getProxyDispatcher(llmOf.llm.proxyURL ?? ''),
          dropped: r.session.messages,
          signal: AbortSignal.timeout(60_000),
        })
        const droppedCount = r.session.messages.length
        await appendSummaryLine(projectId, sessionId, droppedCount, summary)
        setCachedCompact(sessionId, droppedCount, summary)
        return { ok: true, droppedCount, summaryText: summary }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // 选段压缩：把 [startId..endId] 区间（自动取二者在列表中的范围）替换为一条
  // 用户角色的摘要消息。整段替换保证 tool_calls/tool_result 永不拆散。
  ipcMain.handle(
    'sessions:compressRange',
    async (
      _e,
      projectId: string,
      sessionId: string,
      startId: string,
      endId: string,
    ): Promise<ContextOpResult> => {
      const llmOf = await activeLlmOf()
      if ('error' in llmOf) return { ok: false, error: llmOf.error }
      const r = await loadSessionAny(projectId, sessionId)
      if (!r.session) return { ok: false, error: '会话不存在' }
      const msgs = r.session.messages
      const i1 = msgs.findIndex((m) => m.id === startId)
      const i2 = msgs.findIndex((m) => m.id === endId)
      if (i1 < 0 || i2 < 0) return { ok: false, error: '所选消息已不存在（请刷新）' }
      const start = Math.min(i1, i2)
      const end = Math.max(i1, i2)
      const range = msgs.slice(start, end + 1)

      try {
        const summary = await summarizeWithModel({
          llm: llmOf.llm,
          apiKey: llmOf.apiKey,
          dispatcher: getProxyDispatcher(llmOf.llm.proxyURL ?? ''),
          dropped: range,
          signal: AbortSignal.timeout(60_000),
        })
        const replacement: ChatMessage = {
          id: randomUUID(),
          role: 'user',
          createdAt: Date.now(),
          blocks: [{ type: 'text', text: `[已压缩 ${range.length} 条对话]\n${summary}` }],
        }
        msgs.splice(start, range.length, replacement)
        invalidateCompactCache(sessionId) // 历史形状变了，旧摘要缓存作废
        const r2 = await saveSessionInternal(r.session)
        if (!r2.ok) return { ok: false, error: r2.error ?? '保存失败' }
        return { ok: true, droppedCount: range.length, summaryText: summary }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
