import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 生产构建时注入 CSP meta（开发模式不注入，避免干扰 HMR）。
// 注意：渲染进程所有外部交互都走主进程 IPC，因此 connect-src 'self' 即可。
const cspPlugin = {
  name: 'csp-inject',
  apply: 'build' as const,
  transformIndexHtml: (html: string): string =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:">`,
    ),
}

// electron-vite 约定三个构建段：main（主进程）、preload（预加载）、renderer（渲染界面）
// 入口默认取 src/main/index.ts、src/preload/index.ts、src/renderer/index.html
export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['fast-formula-parser', 'bahttext', 'bessel', 'chevrotain', 'regexp-to-ast', 'jstat', 'jszip', 'lie', 'immediate', 'pako', 'readable-stream', 'core-util-is', 'inherits', 'isarray', 'process-nextick-args', 'safe-buffer', 'util-deprecate', 'setimmediate', 'fast-xml-parser', '@nodable/entities', 'fast-xml-builder', 'path-expression-matcher', 'xml-naming', 'is-unsafe', 'strnum', 'anynum'] },
      rollupOptions: { input: { index: 'src/main/index.ts', officeFormulaWorker: 'src/main/officeFormulaWorker.ts' } },
    },
  },
  preload: {},
  renderer: {
    plugins: [react(), cspPlugin],
  },
})
