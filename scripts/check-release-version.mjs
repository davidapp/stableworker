import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) {
  throw new Error('package.json 与 package-lock.json 的版本不一致')
}
if (process.env.GITHUB_REF?.startsWith('refs/tags/v') && process.env.GITHUB_REF !== `refs/tags/v${pkg.version}`) {
  throw new Error(`发布标签必须为 v${pkg.version}`)
}
console.log(`Version OK: ${pkg.version}`)
