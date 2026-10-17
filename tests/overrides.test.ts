import { describe, expect, it } from 'vitest'
import { resolveEffectiveSettings } from '../src/main/config'

const base = {
  toolSwitches: { read_file: false, run_command: true },
  approvalMode: 'confirm' as const,
  permissionRules: { deny: ['run_command(rm *)'], ask: ['write_file(*)'], allow: ['read_file(*)'] },
  projectOverrides: {},
}

describe('resolveEffectiveSettings 合并语义', () => {
  it('无覆盖时等于全局', () => {
    const r = resolveEffectiveSettings(base, 'p1')
    expect(r.approvalMode).toBe('confirm')
    expect(r.toolSwitches).toEqual(base.toolSwitches)
    expect(r.permissionRules).toEqual(base.permissionRules)
  })

  it('approvalMode 标量整体覆盖', () => {
    const r = resolveEffectiveSettings({ ...base, projectOverrides: { p1: { approvalMode: 'fullAccess' } } }, 'p1')
    expect(r.approvalMode).toBe('fullAccess')
  })

  it('toolSwitches 按键合并：覆盖项只改自己的键', () => {
    const r = resolveEffectiveSettings(
      { ...base, projectOverrides: { p1: { toolSwitches: { read_file: true, web_fetch: false } } } },
      'p1',
    )
    expect(r.toolSwitches).toEqual({ read_file: true, run_command: true, web_fetch: false })
  })

  it('permissionRules 与全局合并（各自追加，不替换）', () => {
    const r = resolveEffectiveSettings(
      { ...base, projectOverrides: { p1: { permissionRules: { allow: ['grep(*)'], ask: [], deny: ['web_fetch(*)'] } } } },
      'p1',
    )
    expect(r.permissionRules.deny).toEqual(['run_command(rm *)', 'web_fetch(*)'])
    expect(r.permissionRules.ask).toEqual(['write_file(*)'])
    expect(r.permissionRules.allow).toEqual(['read_file(*)', 'grep(*)'])
  })

  it('其他项目不受影响；projectId 为 null 时用全局', () => {
    const cfg = { ...base, projectOverrides: { p1: { approvalMode: 'plan' as const } } }
    expect(resolveEffectiveSettings(cfg, 'p2').approvalMode).toBe('confirm')
    expect(resolveEffectiveSettings(cfg, null).approvalMode).toBe('confirm')
  })
})
