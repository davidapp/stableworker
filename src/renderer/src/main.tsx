import React from 'react'
import { createRoot } from 'react-dom/client'
// 代码高亮主题；先于自有样式导入，保证我们的覆盖规则优先生效
import 'highlight.js/styles/github-dark.css'
import './styles.css'

// 独立的 API 调试窗口通过 ?page=inspector 打开，只渲染调试面板本身
const page = new URLSearchParams(window.location.search).get('page')

if (page === 'inspector') {
  void import('./components/ApiInspector').then(({ ApiInspector }) => {
    createRoot(document.getElementById('root')!).render(<ApiInspector />)
  })
} else {
  void import('./App').then(({ default: App }) => {
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
  })
}
