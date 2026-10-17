import { loadConfig, saveConfig, broadcastConfigUpdate } from './config'
import type { ToolContext, ToolDefinition } from './tools/index'

/**
 * 规划模式工具化（对齐 Claude Code 的 EnterPlanMode / ExitPlanMode）：
 * - enter_plan_mode：模型主动进入规划模式（只读研究 + 制定计划），写入全局批准模式并广播同步界面
 * - exit_plan_mode：规划完成后把计划呈给用户批准；批准则切回"变更前确认"开始执行，否则继续规划
 * 两个工具都不需要批准（enter 本身只读；exit 的批准动作就是用户在提问卡片上的选择）。
 */

const PLAN_ENTER_NOTE =
  '已进入规划模式：当前只剩只读工具（读文件 / 搜索 / 列目录等）。请完成研究后，' +
  '把完整计划整理好，再调用 exit_plan_mode（plan 参数填计划全文）请用户批准。'

async function setApprovalMode(mode: 'plan' | 'confirm'): Promise<void> {
  const cfg = await loadConfig()
  cfg.approvalMode = mode
  await saveConfig(cfg)
  broadcastConfigUpdate(cfg)
}

export const enterPlanModeTool: ToolDefinition = {
  name: 'enter_plan_mode',
  description:
    '进入规划模式：切换到只读状态，先做研究再制定完整计划，经用户批准后才开始改代码。' +
    '适用于：需求模糊或改动面大、用户要求"先出方案"、需要多方案对比的任务。' +
    '进入后用只读工具完成调研，最后调用 exit_plan_mode 提交计划。',
  inputSchema: { type: 'object', properties: {} },
  kind: 'read',
  async execute() {
    const cfg = await loadConfig()
    if (cfg.approvalMode === 'plan') return { content: PLAN_ENTER_NOTE }
    await setApprovalMode('plan')
    return { content: PLAN_ENTER_NOTE }
  },
}

export const exitPlanModeTool: ToolDefinition = {
  name: 'exit_plan_mode',
  description:
    '规划完成时调用：把最终计划（plan 参数，完整的实施步骤）呈给用户批准。' +
    '用户批准后自动切回执行模式，你随后按计划实施；用户拒绝则继续留在规划模式按反馈修改。' +
    '只在规划模式下可用。',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: '完整计划：要改什么、步骤、涉及文件、风险' },
    },
    required: ['plan'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    const cfg = await loadConfig()
    if (cfg.approvalMode !== 'plan') {
      return { content: '当前不在规划模式（无需退出）。直接按常规流程执行即可。', isError: true }
    }
    const plan = typeof input.plan === 'string' ? input.plan.trim() : ''
    if (!plan) return { content: 'plan 参数不能为空：请把完整计划作为 plan 传入', isError: true }
    if (!ctx.onAskUser) {
      return { content: '当前上下文不支持向用户提问（exit_plan_mode 需要交互环境）', isError: true }
    }
    const answer = await ctx.onAskUser({
      question: `${plan.slice(0, 1500)}${plan.length > 1500 ? '\n…（计划过长已截断展示，完整内容见对话）' : ''}\n\n是否批准该计划并切换到执行模式？`,
      options: ['批准，开始执行', '继续规划'],
    })
    if (answer.includes('批准')) {
      await setApprovalMode('confirm')
      return { content: '用户已批准计划，已切换回执行模式。请按计划开始实施。' }
    }
    return { content: `用户未批准，继续留在规划模式。用户反馈：${answer}`, isError: true }
  },
}
