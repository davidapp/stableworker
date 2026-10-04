import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite 约定三个构建段：main（主进程）、preload（预加载）、renderer（渲染界面）
// 入口默认取 src/main/index.ts、src/preload/index.ts、src/renderer/index.html
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
  },
})
