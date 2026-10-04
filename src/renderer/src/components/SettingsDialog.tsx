import { useState } from 'react'
import { useApp } from '../store'
import * as actions from '../actions'
import type { Currency, ModelPricing, ProviderType } from '../../../shared/types'

/**
 * 预设配置：选一下就填好名称 / 协议 / BaseURL，模型给出常见候选（仍可手输），
 * 并附官方文档链接。apiKey 始终由用户填写，不进代码。
 */
interface ProviderPreset {
  id: string
  label: string
  name: string
  provider: ProviderType
  baseURL: string
  models: string[]
  docsURL: string
}

const PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek',
    provider: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/',
    models: ['deepseek-flash', 'deepseek-pro'],
    docsURL: 'https://api-docs.deepseek.com/zh-cn/quick_start',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    name: '智谱 GLM',
    provider: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    models: ['glm-4.6', 'glm-4.5'],
    docsURL: 'https://docs.bigmodel.cn/cn/guide/start/quickstart',
  },
  {
    id: 'kimi',
    label: 'Moonshot Kimi',
    name: 'Moonshot Kimi',
    provider: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2', 'kimi-k2-turbo-preview'],
    docsURL: 'https://platform.moonshot.cn/docs/introduction',
  },
  {
    id: 'anthropic',
    label: 'Anthropic（Claude 官方）',
    name: 'Anthropic',
    provider: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
    docsURL: 'https://docs.claude.com/zh-CN/docs/get-started',
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    name: 'OpenAI',
    provider: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
    docsURL: 'https://platform.openai.com/docs/quickstart',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地模型）',
    name: 'Ollama 本地',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    models: [], // 本地装了什么模型就填什么
    docsURL: 'https://docs.ollama.com/',
  },
  {
    id: 'custom',
    label: '自定义…',
    name: '',
    provider: 'openai-compatible',
    baseURL: '',
    models: [],
    docsURL: '',
  },
]

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

const stripSlash = (s: string): string => s.replace(/\/+$/, '')

/** 已保存的配置反查预设（按 baseURL + provider 匹配），匹配不上算自定义 */
function detectPresetId(llm: ReturnType<typeof useApp>['llm']): string {
  if (!llm) return 'custom'
  const hit = PRESETS.find(
    (p) => p.baseURL && stripSlash(p.baseURL) === stripSlash(llm.baseURL) && p.provider === llm.provider,
  )
  return hit?.id ?? 'custom'
}

// ---------- 模型价格编辑 ----------

const PRICE_KEYS = [
  { key: 'inputCacheHitOffPeak', label: '命中·闲' },
  { key: 'inputCacheHitPeak', label: '命中·峰' },
  { key: 'inputCacheMissOffPeak', label: '未命中·闲' },
  { key: 'inputCacheMissPeak', label: '未命中·峰' },
  { key: 'outputOffPeak', label: '输出·闲' },
  { key: 'outputPeak', label: '输出·峰' },
] as const

type PriceKey = (typeof PRICE_KEYS)[number]['key']

/** 表格里以字符串编辑，保存时统一 parseFloat */
interface PricingDraft {
  model: string
  currency: Currency
  prices: Record<PriceKey, string>
}

const parsePrice = (s: string): number => {
  const n = parseFloat(s)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export function SettingsDialog() {
  const { llm, modelPricing } = useApp()
  // 组件由 App 条件挂载，每次打开都会基于最新配置重新初始化
  const [form, setForm] = useState(() => ({
    presetId: detectPresetId(llm),
    name: llm?.name ?? '',
    provider: llm?.provider ?? ('openai-compatible' as ProviderType),
    baseURL: llm?.baseURL ?? '',
    model: llm?.model ?? '',
    proxyURL: llm?.proxyURL ?? '',
    apiKey: '',
  }))
  const [pricing, setPricing] = useState<PricingDraft[]>(() =>
    modelPricing.map((p) => ({
      model: p.model,
      currency: p.currency,
      prices: {
        inputCacheHitOffPeak: String(p.inputCacheHitOffPeak),
        inputCacheHitPeak: String(p.inputCacheHitPeak),
        inputCacheMissOffPeak: String(p.inputCacheMissOffPeak),
        inputCacheMissPeak: String(p.inputCacheMissPeak),
        outputOffPeak: String(p.outputOffPeak),
        outputPeak: String(p.outputPeak),
      },
    })),
  )
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState('')

  const preset = PRESETS.find((p) => p.id === form.presetId) ?? PRESETS[PRESETS.length - 1]
  const providerOption = PROVIDER_OPTIONS.find((o) => o.value === form.provider)!

  const applyPreset = (presetId: string): void => {
    if (presetId === 'custom') {
      // 切到自定义只切换模式，不清空已填内容
      setForm((prev) => ({ ...prev, presetId }))
      return
    }
    const p = PRESETS.find((x) => x.id === presetId)
    if (!p) return
    setForm((prev) => ({
      ...prev,
      presetId,
      name: p.name,
      provider: p.provider,
      baseURL: p.baseURL,
      model: p.models[0] ?? '',
    }))
    setTestResult('')
  }

  const updatePricingRow = (index: number, patch: Partial<PricingDraft>): void => {
    setPricing((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const updatePriceCell = (index: number, key: PriceKey, value: string): void => {
    setPricing((rows) =>
      rows.map((r, i) => (i === index ? { ...r, prices: { ...r.prices, [key]: value } } : r)),
    )
  }

  const save = async (): Promise<void> => {
    const cleaned: ModelPricing[] = pricing
      .filter((r) => r.model.trim())
      .map((r) => ({
        model: r.model.trim(),
        currency: r.currency,
        inputCacheHitOffPeak: parsePrice(r.prices.inputCacheHitOffPeak),
        inputCacheHitPeak: parsePrice(r.prices.inputCacheHitPeak),
        inputCacheMissOffPeak: parsePrice(r.prices.inputCacheMissOffPeak),
        inputCacheMissPeak: parsePrice(r.prices.inputCacheMissPeak),
        outputOffPeak: parsePrice(r.prices.outputOffPeak),
        outputPeak: parsePrice(r.prices.outputPeak),
      }))
    await actions.savePricing(cleaned)
    await actions.saveLlm({
      name: form.name,
      provider: form.provider,
      baseURL: form.baseURL,
      model: form.model,
      proxyURL: form.proxyURL,
      apiKey: form.apiKey.trim() || undefined,
    })
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult('')
    const res = await window.api.testLlm({
      name: form.name,
      provider: form.provider,
      baseURL: form.baseURL,
      model: form.model,
      proxyURL: form.proxyURL,
      apiKey: form.apiKey.trim() || undefined,
    })
    setTestResult(res.ok ? `✅ ${res.message}` : `❌ ${res.message}`)
    setTesting(false)
  }

  return (
    <div className="modal-overlay" onClick={() => actions.closeSettings()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>LLM API 设置</h2>

        <label className="field">
          <span>预设（快速填入）</span>
          <select value={form.presetId} onChange={(e) => applyPreset(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {preset.docsURL ? (
          <div className="docs-link">
            官方文档（获取 API Key / 模型列表 / 定价）：
            <a href={preset.docsURL} target="_blank" rel="noreferrer">
              {preset.docsURL}
            </a>
          </div>
        ) : null}

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
            placeholder={providerOption.baseURLPlaceholder}
            onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
          />
        </label>

        <label className="field">
          <span>模型</span>
          <input
            value={form.model}
            list="model-suggestions"
            placeholder={providerOption.modelPlaceholder}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <datalist id="model-suggestions">
            {preset.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
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

        <label className="field">
          <span>HTTP 代理（可选，留空直连）</span>
          <input
            value={form.proxyURL}
            placeholder="例如 http://127.0.0.1:7890"
            onChange={(e) => setForm({ ...form, proxyURL: e.target.value })}
          />
          <small>填写后该配置的所有 API 请求经此代理发送（http/https 代理）；留空则直连。</small>
        </label>

        <div className="field">
          <span>模型价格表（本币 / 每百万 tokens，供 API 调试面板精确计费）</span>
          <div className="pricing-table">
            <div className="pricing-row pricing-head">
              <span>模型</span>
              <span>币种</span>
              {PRICE_KEYS.map((k) => (
                <span key={k.key}>{k.label}</span>
              ))}
              <span />
            </div>
            {pricing.map((row, i) => (
              <div className="pricing-row" key={i}>
                <input
                  value={row.model}
                  placeholder="模型名"
                  onChange={(e) => updatePricingRow(i, { model: e.target.value })}
                />
                <select
                  value={row.currency}
                  onChange={(e) => updatePricingRow(i, { currency: e.target.value as Currency })}
                >
                  <option value="CNY">¥</option>
                  <option value="USD">$</option>
                </select>
                {PRICE_KEYS.map((k) => (
                  <input
                    key={k.key}
                    type="number"
                    min="0"
                    step="any"
                    value={row.prices[k.key]}
                    title={`${k.label}（每百万 tokens）`}
                    onChange={(e) => updatePriceCell(i, k.key, e.target.value)}
                  />
                ))}
                <button
                  className="icon-btn pricing-remove"
                  title="删除该模型价格"
                  onClick={() => setPricing((rows) => rows.filter((_, idx) => idx !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            className="btn"
            onClick={() =>
              setPricing((rows) => [
                ...rows,
                {
                  model: form.model,
                  currency: 'CNY',
                  prices: {
                    inputCacheHitOffPeak: '',
                    inputCacheHitPeak: '',
                    inputCacheMissOffPeak: '',
                    inputCacheMissPeak: '',
                    outputOffPeak: '',
                    outputPeak: '',
                  },
                },
              ])
            }
          >
            ＋ 添加模型价格
          </button>
          <small>
            命中/未命中 = 输入 tokens 的缓存缓存命中与未命中单价；闲/峰 = 高峰/空闲时段（北京时间：
            工作日 09:00–12:00、14:00–18:00 为高峰，周末与法定节假日全天空闲，按请求发起时刻定档）。
            法定节假日表在 config.json 的 holidays 字段维护。
          </small>
        </div>

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
