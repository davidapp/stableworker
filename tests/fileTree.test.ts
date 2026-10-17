import { describe, expect, it } from 'vitest'
import { buildTree } from '../src/renderer/src/components/FileExplorerPanel'

describe('buildTree 文件树构建', () => {
  it('目录在前、按名称排序；嵌套路径正确归组', () => {
    const tree = buildTree(['src/b.ts', 'README.md', 'src/main/llm.ts', 'src/a.ts'])
    expect(tree.map((n) => n.name)).toEqual(['src', 'README.md'])
    const src = tree[0]
    expect(src.children.map((n) => n.name)).toEqual(['main', 'a.ts', 'b.ts'])
    expect(src.children[0].children[0].path).toBe('src/main/llm.ts')
  })

  it('空列表返回空树；同名文件与目录共存时目录排前', () => {
    expect(buildTree([])).toEqual([])
    const tree = buildTree(['notes', 'notes/keep.md'])
    expect(tree[0].children.map((n) => n.name)).toEqual(['keep.md'])
  })
})
