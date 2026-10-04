import type { Api } from '../../preload/index'

/**
 * 把 preload 暴露的 API 挂到 Window 类型上。
 * 注意：不能放在 src/preload/index.d.ts —— 与 index.ts 同名的 .d.ts 会被 TypeScript 遮蔽。
 */
declare global {
  interface Window {
    api: Api
  }
}

export {}
