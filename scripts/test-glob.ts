// glob 匹配行为验证（与 search.ts 的 globToRegExp 逻辑一致）
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

const t = (glob: string, path: string): boolean => globToRegExp(glob).test(path)
const cases: [string, string, boolean][] = [
  ['*.ts', 'a.ts', true],
  ['*.ts', 'src/a.ts', false], // 段内 * 不跨目录
  ['src/**/*.ts', 'src/main/llm.ts', true],
  ['src/**/*.ts', 'src/a.ts', true], // ** 可匹配零层
  ['src/**/*.ts', 'lib/a.ts', false],
  ['*.md', 'README.md', true],
  ['test?.py', 'test1.py', true],
  ['test?.py', 'test12.py', false],
]
let pass = 0
for (const [g, p, want] of cases) {
  const got = t(g, p)
  if (got === want) pass++
  else console.log(`FAIL: ${g} vs ${p} → ${got}（期望 ${want}）`)
}
console.log(`${pass}/${cases.length} 通过`)
