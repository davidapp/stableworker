import { useState } from 'react'
import { useApp } from '../../store'
import * as actions from '../../actions'
import type { BalanceResult, LLMProfileView, ProviderType } from '../../../../shared/types'
import { Icon } from '../Icon'
import { SettingsNotice, type SettingsNoticeValue } from './SettingsNotice'

/** 预设配置：选一下就填好名称 / 协议 / BaseURL，模型给出常见候选（仍可手输），附官方文档 */
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
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    docsURL: 'https://api-docs.deepseek.com/',
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

/** 从服务商 /models 接口拉取可用模型列表（OpenAI 兼容；Anthropic 官方无此接口会返回明确错误） */

/** 按 baseURL + provider 反查预设，匹配不上算自定义 */
function detectPresetId(llm: LLMProfileView | null): string {
  if (!llm) return 'custom'
  const hit = PRESETS.find(
    (p) => p.baseURL && stripSlash(p.baseURL) === stripSlash(llm.baseURL) && p.provider === llm.provider,
  )
  return hit?.id ?? 'custom'
}

interface ProfileDraft {
  id: string | null // null = 新增
  presetId: string
  name: string
  provider: ProviderType
  baseURL: string
  model: string
  proxyURL: string
  apiKey: string
  /** 编辑已有配置档时用于 apiKey 占位提示 */
  hasApiKey: boolean
  apiKeyHint: string
  contextWindowOverride: string
}

function draftFromProfile(p: LLMProfileView): ProfileDraft {
  return {
    id: p.id,
    presetId: detectPresetId(p),
    name: p.name,
    provider: p.provider,
    baseURL: p.baseURL,
    model: p.model,
    proxyURL: p.proxyURL,
    apiKey: '',
    hasApiKey: p.hasApiKey,
    apiKeyHint: p.apiKeyHint,
    contextWindowOverride: p.contextWindowOverride?.toString() ?? '',
  }
}

function blankDraft(): ProfileDraft {
  return {
    id: null,
    presetId: 'custom',
    name: '',
    provider: 'openai-compatible',
    baseURL: '',
    model: '',
    proxyURL: '',
    apiKey: '',
    hasApiKey: false,
    apiKeyHint: '',
    contextWindowOverride: '',
  }
}

/** LLM 配置页：配置档管理器（列表 + 新增/编辑/删除，激活项在输入框下方可随时切换） */
export function LlmConfigPage() {
  const { llmProfiles, activeLlmId } = useApp()
  const [editing, setEditing] = useState<ProfileDraft | null>(null)
  const [fetchedByProfile, setFetchedByProfile] = useState<Record<string, { id: string; name?: string }[]>>({})
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [balanceFor, setBalanceFor] = useState<Record<string, BalanceResult>>({})
  const [rowNotice, setRowNotice] = useState<{ profileId: string; tone: 'success' | 'warning'; text: string } | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testing, setTesting] = useState(false)
  const [refreshingContext, setRefreshingContext] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<SettingsNoticeValue | null>(null)
  const [saved, setSaved] = useState(false)

  const fetchModelsFor = async (p: LLMProfileView): Promise<void> => {
    setFetchingModels(true)
    try {
      const r = await window.api.listModels({ id: p.id, provider: p.provider, name: p.name, baseURL: p.baseURL })
      if (!r.ok) {
        setRowNotice({ profileId: p.id, tone: 'warning', text: `获取模型列表失败：${r.error ?? '未知错误'}` })
      } else {
        setFetchedByProfile((prev) => ({ ...prev, [p.id]: r.models }))
        setRowNotice({ profileId: p.id, tone: 'success', text: `已获取 ${r.models.length} 个模型，编辑时输入框可选` })
      }
    } finally {
      setFetchingModels(false)
    }
  }

  const [balanceBusy, setBalanceBusy] = useState(false)
  const queryBalanceFor = async (profileId: string): Promise<void> => {
    setBalanceBusy(true)
    try {
      const r = await window.api.queryBalance()
      setBalanceFor((prev) => ({ ...prev, [profileId]: r }))
    } finally {
      setBalanceBusy(false)
    }
  }

  const startNew = (): void => {
    setTestResult(null)
    setEditing(blankDraft())
  }

  const startEdit = (p: LLMProfileView): void => {
    setTestResult(null)
    setEditing(draftFromProfile(p))
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    const override = editing.contextWindowOverride.trim() ? Number(editing.contextWindowOverride) : 0
    if (!Number.isSafeInteger(override) || override < 0) {
      setTestResult({ tone: 'error', text: '上下文容量必须是非负整数，留空表示自动获取' })
      return
    }
    await actions.saveProfile({
      id: editing.id ?? undefined,
      name: editing.name,
      provider: editing.provider,
      baseURL: editing.baseURL,
      model: editing.model,
      proxyURL: editing.proxyURL,
      apiKey: editing.apiKey.trim() || undefined,
      contextWindowOverride: override,
    })
    setEditing(null)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const remove = async (p: LLMProfileView): Promise<void> => {
    if (
      !await actions.confirm(
        `删除配置档「${p.name}」？${
          p.id === activeLlmId ? '\n\n这是当前激活的配置档，删除后会自动切换到列表中的第一个。' : ''
        }`,
      )
    ) {
      return
    }
    await actions.deleteProfile(p.id)
  }

  const test = async (): Promise<void> => {
    if (!editing) return
    setTesting(true)
    setTestResult(null)
    const res = await window.api.testLlm({
      id: editing.id ?? undefined,
      name: editing.name,
      provider: editing.provider,
      baseURL: editing.baseURL,
      model: editing.model,
      proxyURL: editing.proxyURL,
      apiKey: editing.apiKey.trim() || undefined,
    })
    setTestResult({ tone: res.ok ? 'success' : 'error', text: res.message })
    setTesting(false)
  }

  // ---------- 编辑器视图 ----------
  if (editing) {
    const preset = PRESETS.find((p) => p.id === editing.presetId) ?? PRESETS[PRESETS.length - 1]
    const providerOption = PROVIDER_OPTIONS.find((o) => o.value === editing.provider)!

    const applyPreset = (presetId: string): void => {
      if (presetId === 'custom') {
        setEditing((prev) => (prev ? { ...prev, presetId } : prev))
        return
      }
      const p = PRESETS.find((x) => x.id === presetId)
      if (!p) return
      setEditing((prev) =>
        prev ? { ...prev, presetId, name: p.name, provider: p.provider, baseURL: p.baseURL, model: p.models[0] ?? '' } : prev,
      )
      setTestResult(null)
    }

    return (
      <div className="settings-page">
        <h2>{editing.id ? '编辑配置档' : '新增配置档'}</h2>

        <label className="field">
          <span>预设（快速填入）</span>
          <select value={editing.presetId} onChange={(e) => applyPreset(e.target.value)}>
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
            value={editing.name}
            placeholder="例如 DeepSeek"
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
        </label>

        <label className="field">
          <span>协议类型</span>
          <select
            value={editing.provider}
            onChange={(e) => setEditing({ ...editing, provider: e.target.value as ProviderType })}
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
            value={editing.baseURL}
            placeholder={providerOption.baseURLPlaceholder}
            onChange={(e) => setEditing({ ...editing, baseURL: e.target.value })}
          />
        </label>

        <label className="field">
          <span>模型</span>
          <input
            value={editing.model}
            list="model-suggestions"
            placeholder={providerOption.modelPlaceholder}
            onChange={(e) => setEditing({ ...editing, model: e.target.value })}
          />
          <datalist id="model-suggestions">
            {(editing?.id ? fetchedByProfile[editing.id] ?? preset.models.map((m) => ({ id: m, name: undefined })) : preset.models.map((m) => ({ id: m, name: undefined }))).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? ''}
              </option>
            ))}
          </datalist>
        </label>

        <label className="field">
          <span>上下文容量覆盖（tokens，可选）</span>
          <input type="number" min="1" step="1" value={editing.contextWindowOverride}
            placeholder="留空，从服务元数据或已核实的官方配置获取"
            onChange={(e) => setEditing({ ...editing, contextWindowOverride: e.target.value })} />
          <small>只有需要手动指定时填写；容量详情会明确标为手动配置。</small>
        </label>

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={editing.apiKey}
            placeholder={
              editing.hasApiKey ? `已保存 ${editing.apiKeyHint}（留空则保持不变）` : 'sk-…'
            }
            onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
          />
          <small>密钥经 Electron safeStorage 加密后保存在本地，不会原样出现在配置里。</small>
        </label>

        <label className="field">
          <span>HTTP 代理（可选，留空直连）</span>
          <input
            value={editing.proxyURL}
            placeholder="例如 http://127.0.0.1:7890"
            onChange={(e) => setEditing({ ...editing, proxyURL: e.target.value })}
          />
          <small>填写后该配置档的所有 API 请求经此代理发送（http/https 代理）；留空则直连。</small>
        </label>

        <SettingsNotice notice={testResult} />

        <div className="settings-page-actions">
          <button className="btn" disabled={testing} onClick={() => void test()}>
            <Icon name="refresh" size={14} />{testing ? '测试中…' : '测试连接'}
          </button>
          <div className="spacer" />
          <button className="btn" onClick={() => setEditing(null)}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    )
  }

  // ---------- 列表视图 ----------
  return (
    <div className="settings-page">
      <h2>LLM 配置</h2>
      <p className="hint-line">
        可以配置多套模型（不同服务商 / 不同模型 / 不同代理），在输入框下方的模型选择器里随时切换。
      </p>

      {llmProfiles.length === 0 ? (
        <div className="profile-empty">还没有模型配置。添加服务商与 API Key，即可开始对话。</div>
      ) : (
        <>
          <div className="profile-list">
            {llmProfiles.map((p) => (
              <div key={p.id} className={`profile-row ${p.id === activeLlmId ? 'active' : ''}`}>
                <div className="profile-info">
                  <span className="profile-name">
                    {p.name}
                    {p.id === activeLlmId ? <span className="status-line status-success"><span className="status-dot" />使用中</span> : null}
                  </span>
                  <small>
                    {p.provider === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'} · {p.model || '(未设模型)'} ·{' '}
                    {p.hasApiKey ? `密钥 ${p.apiKeyHint}` : '未设密钥'}
                  </small>
                  <small>
                    上下文：{p.contextInfo ? `${p.contextInfo.contextWindow.toLocaleString()} tokens · ${p.contextInfo.source === 'api' ? '服务元数据' : p.contextInfo.source === 'manual' ? '手动配置' : '官方文档'}` : '上限未确认'}
                    {balanceFor[p.id] ? (() => {
                      const b = balanceFor[p.id]
                      return b.ok
                        ? ` · 余额：${b.currency === 'USD' ? '$' : b.currency === 'CNY' ? '¥' : ''}${b.totalBalance ?? '?'}${b.grantedBalance && b.grantedBalance !== '0' ? ` · 赠送 ${b.grantedBalance}` : ''}${b.isAvailable === false ? ' · 账户不可用' : ''}`
                        : ` · 余额查询失败：${b.error ?? '未知原因'}`
                    })() : null}
                  </small>
                  {rowNotice?.profileId === p.id ? (
                    <small className={rowNotice.tone === 'success' ? 'status-line status-success' : 'status-line status-error'} style={{ display: 'block' }}>
                      {rowNotice.text}
                    </small>
                  ) : null}
                </div>
                <div className="profile-actions">
                  <div className="mode-menu-wrap">
                    <button className="btn" onClick={() => setMenuFor(menuFor === p.id ? null : p.id)}>
                      操作 ▾
                    </button>
                    {menuFor === p.id ? (
                      <div className="mode-menu profile-menu">
                        <button className="mode-item" disabled={fetchingModels} onClick={() => {
                          setMenuFor(null)
                          void fetchModelsFor(p)
                        }}>
                          获取模型列表
                        </button>
                        <button className="mode-item" disabled={refreshingContext !== null} onClick={() => {
                          setMenuFor(null)
                          setRefreshingContext(p.id)
                          void actions.refreshModelContext(p.id).then((result) => {
                            setRefreshingContext(null)
                            setRowNotice({ profileId: p.id, tone: result.ok ? 'success' : 'warning', text: result.message })
                          })
                        }}>
                          获取容量
                        </button>
                        <button
                          className="mode-item"
                          disabled={p.id !== activeLlmId || balanceBusy}
                          title={p.id === activeLlmId ? '' : '仅使用中的配置档可查询'}
                          onClick={() => {
                            setMenuFor(null)
                            void queryBalanceFor(p.id)
                          }}
                        >
                          查询余额
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {p.id !== activeLlmId ? (
                    <button className="btn" onClick={() => void actions.setActiveLlm(p.id)}>
                      使用
                    </button>
                  ) : null}
                  <button className="btn" onClick={() => startEdit(p)}>
                    <Icon name="edit" size={14} />编辑
                  </button>
                  <button className="btn btn-danger-ghost" onClick={() => void remove(p)}>
                    <Icon name="trash" size={14} />删除
                  </button>
                </div>
              </div>
            ))}
          </div>

        </>
      )}

      <div className="settings-page-actions">
        <button className="btn btn-primary" onClick={startNew}>
          <Icon name="plus" size={14} />新增配置
        </button>
        <div className="spacer" />
        {saved ? <span className="saved-hint" role="status"><Icon name="check" size={14} />已保存</span> : null}
      </div>
    </div>
  )
}