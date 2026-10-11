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

const pendingApprovals = new Map<string, PendingApproval>()
/** 通用用户输入挂起（AskUserQuestion 等）：questionId → resolve */
const pendingInputs = new Map<string, { resolve: (answer: string) => void; sessionId?: string }>()

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
        if (!pendingApprovals.delete(approvalId)) return
        resolve(outcome)
      },
    }
    pendingApprovals.set(approvalId, entry)
    emit({ type: 'approval_request', sessionId, toolUseId, approvalId, suggestRule })
    const t = setTimeout(() => entry.resolve('timeout'), APPROVAL_TIMEOUT_MS)
    t.unref()
  })
}

/** 渲染进程回传用户决定；返回 false 表示该批准已失效（超时/停止/未知 id） */
export function respondApproval(approvalId: string, approved: boolean): { ok: boolean } {
  const entry = pendingApprovals.get(approvalId)
  if (!entry) return { ok: false }
  entry.resolve(approved ? 'approved' : 'rejected')
  return { ok: true }
}

/** 用户停止生成时，把该会话所有挂起的批准按"已停止"处理 */
export function resolveSessionApprovals(sessionId: string): void {
  for (const entry of [...pendingApprovals.values()]) {
    if (entry.sessionId === sessionId) entry.resolve('stopped')
  }
}

// ---------- 通用用户输入挂起（AskUserQuestion 工具） ----------

/** 发出问题卡片并挂起等待用户作答；超时自动以"（超时未回答）"收尾 */
export function requestUserInput(
  sessionId: string,
  toolUseId: string,
  question: string,
  options: string[],
  emit: (event: ChatEvent) => void,
): Promise<string> {
  const questionId = randomUUID()
  return new Promise((resolve) => {
    pendingInputs.set(questionId, { resolve })
    emit({ type: 'ask_user', sessionId, toolUseId, questionId, question, options })
    const t = setTimeout(() => {
      if (pendingInputs.delete(questionId)) resolve('（超时未回答）')
    }, APPROVAL_TIMEOUT_MS)
    t.unref()
  })
}

export function respondUserInput(questionId: string, answer: string): boolean {
  const e = pendingInputs.get(questionId)
  if (!e) return false
  e.resolve(answer)
  return true
}

/** 用户停止时，挂起中的提问按"已停止"收尾 */
export function resolveSessionUserInputs(sessionId: string): void {
  for (const e of [...pendingInputs.values()]) {
    if (e.sessionId === sessionId) e.resolve('（用户停止）')
  }
}

export function registerApprovalHandlers(): void {
  ipcMain.handle('approval:respond', (_e, approvalId: string, approved: boolean) => respondApproval(approvalId, approved))
  ipcMain.handle('askUser:respond', (_e, questionId: string, answer: string) => respondUserInput(questionId, answer))
}
