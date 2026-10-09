import { describe, expect, it } from 'vitest'
import {
  evaluateRules,
  parseRule,
  ruleContentFor,
  ruleMatches,
  suggestRule,
} from '../src/main/permissions'
import type { PermissionRules } from '../src/shared/types'

const cmd = (command: string) => ({ command })
const file = (path: string) => ({ path })

describe('parseRule', () => {
  it('无内容规则', () => {
    expect(parseRule('run_command')).toEqual({ tool: 'run_command', content: null })
  })
  it('精确内容', () => {
    expect(parseRule('run_command(npm test)')).toEqual({ tool: 'run_command', content: 'npm test' })
  })
  it('前缀通配', () => {
    expect(parseRule('run_command(npm:*)')).toEqual({ tool: 'run_command', content: 'npm:*' })
    expect(parseRule('edit_file(src/*)')).toEqual({ tool: 'edit_file', content: 'src/*' })
  })
  it('空规则返回 null', () => {
    expect(parseRule('  ')).toBeNull()
  })
})

describe('ruleMatches', () => {
  it('无内容规则匹配任何调用', () => {
    expect(ruleMatches('list_files', 'list_files', file('x'))).toBe(true)
  })
  it('工具名不匹配', () => {
    expect(ruleMatches('run_command', 'edit_file', cmd('npm test'))).toBe(false)
  })
  it('精确匹配', () => {
    expect(ruleMatches('run_command(npm test)', 'run_command', cmd('npm test'))).toBe(true)
    expect(ruleMatches('run_command(npm test)', 'run_command', cmd('npm test --watch'))).toBe(false)
  })
  it(':* 前缀匹配（Claude 语法）', () => {
    expect(ruleMatches('run_command(npm:*)', 'run_command', cmd('npm test'))).toBe(true)
    expect(ruleMatches('run_command(npm:*)', 'run_command', cmd('pnpm test'))).toBe(false)
  })
  it('尾缀 * 前缀匹配', () => {
    expect(ruleMatches('edit_file(src/*)', 'edit_file', file('src/main/a.ts'))).toBe(true)
    expect(ruleMatches('edit_file(src/*)', 'edit_file', file('docs/a.md'))).toBe(false)
  })
})

describe('evaluateRules 优先级', () => {
  const rules: PermissionRules = {
    allow: ['run_command(npm:*)'],
    ask: ['run_command(git push:*)'],
    deny: ['run_command(rm:*)'],
  }

  it('deny 优先于 allow', () => {
    expect(evaluateRules(rules, 'run_command', cmd('rm -rf /'))).toBe('deny')
  })
  it('ask 优先于 deny 之外的一切', () => {
    expect(evaluateRules(rules, 'run_command', cmd('git push origin main'))).toBe('ask')
  })
  it('allow 命中', () => {
    expect(evaluateRules(rules, 'run_command', cmd('npm run build'))).toBe('allow')
  })
  it('未命中返回 null', () => {
    expect(evaluateRules(rules, 'run_command', cmd('python x.py'))).toBeNull()
  })
  it('文件路径规则', () => {
    expect(evaluateRules({ allow: ['edit_file(src/*)'], ask: [], deny: [] }, 'edit_file', file('src/a.ts'))).toBe('allow')
  })
})

describe('ruleContentFor / suggestRule', () => {
  it('run_command 取 command，建议前两条 + 通配', () => {
    expect(ruleContentFor('run_command', cmd('npm test --watch'))).toBe('npm test --watch')
    expect(suggestRule('run_command', cmd('npm test --watch'))).toBe('run_command(npm test *)')
  })
  it('路径工具取目录前缀', () => {
    expect(suggestRule('edit_file', file('src/main/a.ts'))).toBe('edit_file(src/main/*)')
  })
})
