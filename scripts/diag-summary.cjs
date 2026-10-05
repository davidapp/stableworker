// 诊断脚本：用真实配置复现摘要请求（Electron 内解密 safeStorage 的 key）
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

app.setPath('userData', process.env.APPDATA + '\\stableworker')
app.whenReady().then(async () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(process.env.APPDATA + '/stableworker/config.json', 'utf8'))
    const llm = cfg.llmProfiles.find((p) => p.id === cfg.activeLlmId)
    console.log('配置档:', llm.name, '| provider:', llm.provider, '| model:', llm.model, '| baseURL:', llm.baseURL)
    console.log('thinkingEffort:', JSON.stringify(llm.thinkingEffort), '| proxyURL:', JSON.stringify(llm.proxyURL))

    let key = llm.apiKey
    if (key.startsWith('enc:v1:')) key = safeStorage.decryptString(Buffer.from(key.slice(7), 'base64'))
    else if (key.startsWith('plain:')) key = key.slice(6)
    console.log('key 解密:', key ? '成功（' + key.slice(0, 6) + '…）' : '失败')

    const { fetch } = require('undici')
    const base = (llm.baseURL || (llm.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '')
    const summaryPrompt = '请把下面的对话历史压缩成摘要（测试）\n=== 对话历史开始 ===\n用户: 优化下 hello.txt\n=== 对话历史结束 ==='
    let url, headers, body
    if (llm.provider === 'anthropic') {
      url = base + '/v1/messages'
      headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      body = { model: llm.model, max_tokens: 1200, system: '你是会话摘要助手。只输出摘要本身。', messages: [{ role: 'user', content: summaryPrompt }], stream: false }
    } else {
      url = base + '/chat/completions'
      headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key }
      body = { model: llm.model, messages: [{ role: 'system', content: '你是会话摘要助手。只输出摘要本身。' }, { role: 'user', content: summaryPrompt }], stream: false }
      if (llm.thinkingEffort && llm.thinkingEffort !== 'off') body.reasoning_effort = llm.thinkingEffort
    }
    console.log('请求:', url)
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    console.log('STATUS:', res.status, res.statusText)
    const text = await res.text()
    console.log('响应前 400 字符:', text.slice(0, 400))
  } catch (e) {
    console.error('诊断异常:', e && e.message)
  }
  app.quit()
})
