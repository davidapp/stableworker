import { useState } from 'react'
import { useApp } from '../store'
import * as actions from '../actions'
import type { ProviderType } from '../../../shared/types'

const PROVIDER_OPTIONS: {
  value: ProviderType
  label: string
  baseURLPlaceholder: string
  modelPlaceholder: string
}[] = [
  {
    value: 'openai-compatible',
    label: 'OpenAI 兼容（DeepSeek / GLM / Kimi / OpenRouter / vLLM…）',
    baseURLPlaceholder: 'https://api.deepseek.com/v1',
    modelPlaceholder: 'deepseek-chat',
  },
  {
    value: 'anthropic',
    label: 'Anthropic（Claude 官方 API）',
    baseURLPlaceholder: 'https://api.anthropic.com（可留空走默认）',
    modelPlaceholder: 'claude-sonnet-4-5',
  },
]

export function SettingsDialog() {
  const { llm } = useApp()
  // 组件由 App 条件挂载，每次打开都会基于最新配置重新初始化
  const [form, setForm] = useState(() => ({
    name: llm?.name ?? '',
    provider: llm?.provider ?? ('openai-compatible' as ProviderType),
    baseURL: llm?.baseURL ?? '',
    model: llm?.model ?? '',
    apiKey: '',
  }))
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState('')

  const option = PROVIDER_OPTIONS.find((o) => o.value === form.provider)!

  const save = async (): Promise<void> => {
    await actions.saveLlm({ ...form, apiKey: form.apiKey.trim() || undefined })
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult('')
    const res = await window.api.testLlm({ ...form, apiKey: form.apiKey.trim() || undefined })
    setTestResult(res.ok ? `✅ ${res.message}` : `❌ ${res.message}`)
    setTesting(false)
  }

  return (
    <div className="modal-overlay" onClick={() => actions.closeSettings()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>LLM API 设置</h2>

        <label className="field">
          <span>配置名称</span>
          <input
            value={form.name}
            placeholder="例如 DeepSeek"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>

        <label className="field">
          <span>协议类型</span>
          <select
            value={form.provider}
            onChange={(e) => setForm({ ...form, provider: e.target.value as ProviderType })}
          >
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Base URL</span>
          <input
            value={form.baseURL}
            placeholder={option.baseURLPlaceholder}
            onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
          />
        </label>

        <label className="field">
          <span>模型</span>
          <input
            value={form.model}
            placeholder={option.modelPlaceholder}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
        </label>

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={form.apiKey}
            placeholder={llm?.hasApiKey ? `已保存 ${llm.apiKeyHint}（留空则保持不变）` : 'sk-…'}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
          <small>密钥经 Electron safeStorage 加密后保存在本地，不会原样出现在配置里。</small>
        </label>

        {testResult ? <div className="test-result">{testResult}</div> : null}

        <div className="modal-actions">
          <button className="btn" disabled={testing} onClick={() => void test()}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <div className="spacer" />
          <button className="btn" onClick={() => actions.closeSettings()}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
