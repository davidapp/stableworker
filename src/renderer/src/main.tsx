import React from 'react'
import { createRoot } from 'react-dom/client'
// 代码高亮主题；先于自有样式导入，保证我们的覆盖规则优先生效
import 'highlight.js/styles/github-dark.css'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
