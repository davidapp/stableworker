import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '../src/main/tools'
import { resolveEffectiveSettings } from '../src/main/config'
import { toolsForTaskMode } from '../src/main/officeMode'

const base: ToolDefinition[] = [
  { name: 'list_files', description: '', inputSchema: {}, kind: 'read', execute: async () => ({ content: '' }) },
  { name: 'read_file', description: '', inputSchema: {}, kind: 'read', execute: async () => ({ content: '' }) },
  { name: 'run_command', description: '', inputSchema: {}, kind: 'system', requiresApproval: true, execute: async () => ({ content: '' }) },
  { name: 'memory', description: '', inputSchema: {}, execute: async () => ({ content: '' }) },
]

const officeTools: ToolDefinition[] = [
  { name: 'office_read_document', description: '', inputSchema: {}, kind: 'read', execute: async () => ({ content: '' }) },
  { name: 'office_create_document', description: '', inputSchema: {}, kind: 'system', execute: async () => ({ content: '' }) },
]

describe('按模式取工具池', () => {
  it('编程模式 = 完整基础池', () => {
    const pool = toolsForTaskMode('coding', base, officeTools)
    expect(pool.map((t) => t.name)).toEqual(['list_files', 'read_file', 'run_command', 'memory'])
  })

  it('办公模式 = 通用白名单 + office 工具（memory 已入白名单，编码工具被排除）', () => {
    const pool = toolsForTaskMode('office', base, officeTools)
    const names = pool.map((t) => t.name)
    expect(names).toContain('list_files')
    expect(names).toContain('memory')
    expect(names).toContain('office_read_document')
    expect(names).toContain('office_create_document')
    expect(names).not.toContain('read_file')
    expect(names).not.toContain('run_command')
  })
})

describe('工具开关按模式生效', () => {
  const cfg = {
    toolSwitches: { read_file: false },
    officeToolSwitches: { list_files: false },
    approvalMode: 'confirm' as const,
    permissionRules: { allow: [], ask: [], deny: [] },
    projectOverrides: {},
  }

  it('编程模式读 toolSwitches，办公模式读 officeToolSwitches', () => {
    const coding = resolveEffectiveSettings(cfg, 'coding')
    expect(coding.toolSwitches.read_file).toBe(false)
    expect(coding.toolSwitches.list_files).toBeUndefined() // 未记录 = 默认启用；办公的开关不影响编程
    const office = resolveEffectiveSettings(cfg, 'office')
    expect(office.toolSwitches.list_files).toBe(false)
    expect(office.toolSwitches.read_file).toBeUndefined()
  })
})
