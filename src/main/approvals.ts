import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ChatEvent } from '../shared/types'

/**
 * 批准门：危险工具（requiresApproval）执行前，代理循环在这里挂起，
 * 等待用户在渲染进程的确认卡片上做出决定。
 *
 * 模式：requestApproval 返回一个 Promise，主进程把 approval_request 事件推给
 * 渲染进程；用户点"允许/拒绝"后渲染进程调用 approval:respond，
 * 对应的 Promise 被 resolve——这就是"主进程等待用户决策"的完整闭环。
 * 超时与用户停止都会自动拒绝，避免循环永久挂起。
 */

export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout' | 'stopped'

const APPROVAL_TIMEOUT_MS = 120_000

interface PendingApproval {
  sessionId: string
  resolve: (outcome: ApprovalOutcome) => void
}

const pending = new Map<string, PendingApproval>()

/** 发起批准请求：推送事件给渲染进程并挂起等待决定 */
export function requestApproval(
  sessionId: string,
  toolUseId: string,
  emit: (event: ChatEvent) => void,
  suggestRule?: string,
): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    const approvalId = randomUUID()
    const entry: PendingApproval = {
      sessionId,
      resolve: (outcome) => {
        // 防止超时/停止/用户响应竞争导致二次 resolve
        if (!pending.delete(approvalId)) return
        resolve(outcome)
      },
    }
    pending.set(approvalId, entry)
    emit({ type: 'approval_request', sessionId, toolUseId, approvalId, suggestRule })
    const t = setTimeout(() => entry.resolve('timeout'), APPROVAL_TIMEOUT_MS)
    t.unref()
  })
}

/** 渲染进程回传用户决定；返回 false 表示该批准已失效（超时/停止/未知 id） */
export function respondApproval(approvalId: string, approved: boolean): { ok: boolean } {
  const entry = pending.get(approvalId)
  if (!entry) return { ok: false }
  entry.resolve(approved ? 'approved' : 'rejected')
  return { ok: true }
}

/** 用户停止生成时，把该会话所有挂起的批准按"已停止"处理 */
export function resolveSessionApprovals(sessionId: string): void {
  for (const entry of [...pending.values()]) {
    if (entry.sessionId === sessionId) entry.resolve('stopped')
  }
}

export function registerApprovalHandlers(): void {
  ipcMain.handle('approval:respond', (_e, approvalId: string, approved: boolean) => respondApproval(approvalId, approved))
}
