import { describe, expect, it } from 'vitest'
import type { ChatHistoryMessage, ToolUseBlock } from '../src/shared/types'
import type { ToolDefinition } from '../src/main/tools/index'
import { runSubagent } from '../src/main/subagent'

const readTool: ToolDefinition = {
  name: 'read_file',
  description: 'read',
  inputSchema: { type: 'object' },
  requiresApproval: false,
  async execute() {
    return { content: 'file body' }
  },
}
const writeTool: ToolDefinition = {
  name: 'write_file',
  description: 'write',
  inputSchema: { type: 'object' },
  requiresApproval: true,
  kind: 'edit',
  async execute() {
    return { content: 'ok' }
  },
}
const askTool: ToolDefinition = {
  name: 'ask_user_question',
  description: 'ask',
  inputSchema: { type: 'object' },
  async execute() {
    return { content: 'ok' }
  },
}
const taskTool: ToolDefinition = {
  name: 'task',
  description: 'subagent',
  inputSchema: { type: 'object' },
  async execute() {
    return { content: 'ok' }
  },
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input, status: 'running' }
}

describe('子代理循环', () => {
  it('工具轮次后输出最终报告，工具池排除 task 与 ask_user_question', async () => {
    const calls: ChatHistoryMessage[][] = []
    const executed: string[] = []
    const progress: string[] = []
    let n = 0
    const result = await runSubagent({
      prompt: '调研 llm.ts 的代理循环',
      subagentType: 'general-purpose',
      baseTools: [readTool, writeTool, askTool, taskTool],

      signal: new AbortController().signal,
      onProgress: (l) => progress.push(l),
      callRound: async (messages, tools) => {
        calls.push(JSON.parse(JSON.stringify(messages)) as ChatHistoryMessage[])
        if (n++ === 0) {
          expect([...tools.map((t) => t.name)].sort()).toEqual(['read_file', 'write_file'])
          return { blocks: [toolUse('t1', 'read_file', { path: 'src/llm.ts' })] }
        }
        return { blocks: [{ type: 'text', text: '最终报告：循环在 chatSend，共 8 轮上限。' }] }
      },
      executeTool: async (tu) => {
        executed.push(tu.name)
        tu.status = 'done'
        tu.result = 'file body content'
        tu.durationMs = 5
      },
    })

    expect(result).toEqual({ content: '最终报告：循环在 chatSend，共 8 轮上限。', isError: false })
    expect(executed).toEqual(['read_file'])
    // 第二轮请求的历史里，工具调用块带着执行结果（toApiTurns 据此映射 tool_results）
    const assistant = calls[1][1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.blocks[0]).toMatchObject({ type: 'tool_use', id: 't1', result: 'file body content', status: 'done' })
    expect(progress.some((l) => l.includes('🛠 read_file'))).toBe(true)
    expect(progress.some((l) => l.includes('✓ read_file'))).toBe(true)
  })

  it('Explore 类型：只读池（过滤所有需要批准的工具）', async () => {
    let pool: string[] = []
    await runSubagent({
      prompt: '只读调研',
      subagentType: 'Explore',
      baseTools: [readTool, writeTool, askTool, taskTool],

      signal: new AbortController().signal,
      onProgress: () => {},
      callRound: async (_m, tools) => {
        pool = tools.map((t) => t.name)
        return { blocks: [{ type: 'text', text: '研究结论' }] }
      },
      executeTool: async () => {},
    })
    expect(pool).toEqual(['read_file'])
  })

  it('达到轮次上限后不带工具收尾汇总', async () => {
    let round = 0
    let finalCallHadNoTools = false
    const result = await runSubagent({
      prompt: '一直调工具',
      subagentType: 'general-purpose',
      baseTools: [readTool],

      maxRounds: 2,
      signal: new AbortController().signal,
      onProgress: () => {},
      callRound: async (_m, tools) => {
        round++
        if (tools.length === 0) {
          finalCallHadNoTools = true
          return { blocks: [{ type: 'text', text: '收尾汇总报告' }] }
        }
        return { blocks: [toolUse(`t${round}`, 'read_file')] }
      },
      executeTool: async (tu) => {
        tu.status = 'done'
        tu.result = 'x'
      },
    })
    expect(finalCallHadNoTools).toBe(true)
    expect(result).toEqual({ content: '收尾汇总报告', isError: false })
  })

  it('signal 已中止时立即停止，不发起任何请求', async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await runSubagent({
      prompt: 'x',
      subagentType: 'general-purpose',
      baseTools: [readTool],

      signal: ac.signal,
      onProgress: () => {},
      callRound: async () => {
        throw new Error('不应被调用')
      },
      executeTool: async () => {},
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('停止')
  })
})
