import { describe, expect, it } from 'vitest'
import { officeSystemPrompt, toolsForTaskMode } from '../src/main/officeMode'
import type { ToolDefinition } from '../src/main/tools'

const tool = (name: string): ToolDefinition => ({ name, description: '', inputSchema: {}, execute: async () => ({ content: '' }) })

describe('独立办公能力边界', () => {
  it('办公只开放资料工具与通用协作工具，无法退回编码写入/命令工具', () => {
    const base = ['list_files', 'read_file', 'write_file', 'edit_file', 'multi_edit', 'run_command', 'task_stop', 'web_fetch', 'todo_write', 'ask_user_question'].map(tool)
    const docs = ['office_read_document', 'office_create_document', 'office_list_artifacts'].map(tool)
    expect(toolsForTaskMode('office', base, docs).map((t) => t.name)).toEqual(['list_files', 'web_fetch', 'todo_write', 'ask_user_question', ...docs.map((t) => t.name)])
    expect(toolsForTaskMode('coding', base, docs)).toBe(base)
  })
  it('提示词要求真实文件、任务隔离和注明文档能力的实际限制', () => {
    const prompt = officeSystemPrompt('/fixture/office/task')
    expect(prompt).toContain('/fixture/office/task')
    expect(prompt).toContain('office_create_document')
    expect(prompt).toContain('不执行公式')
    expect(prompt).toContain('暂无 OCR')
  })
})
