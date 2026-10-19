import { useState } from 'react'
import type { MediaCapability, MediaApiView } from '../../../../shared/types'
import { useApp } from '../../store'
import * as actions from '../../actions'
import { Icon } from '../Icon'
import { t } from '../../i18n'

interface CapabilitySpec {
  key: MediaCapability
  label: string
  icon: 'file' | 'copy' | 'chat' | 'question' | 'video'
  desc: string
  example: string
}

const CAPABILITIES: CapabilitySpec[] = [
  { key: 'textToImage', label: '文生图', icon: 'file', desc: '输入文字描述生成图片。', example: 'OpenAI Images · 智谱 CogView · 通义万相 · SiliconFlow' },
  { key: 'imageToImage', label: '图生图', icon: 'copy', desc: '以图片为底图进行改绘、扩展或风格化。', example: 'OpenAI Images Edits · 通义万相' },
  { key: 'textToAudio', label: '文生音频', icon: 'chat', desc: '文本转语音（TTS）或音效，用于旁白配音。', example: 'OpenAI TTS · MiniMax 语音 · 火山引擎' },
  { key: 'speechRecognition', label: '语音识别', icon: 'question', desc: '音频转文字（ASR），用于素材字幕、口播整理。', example: 'OpenAI Whisper · 讯飞 · 阿里听悟' },
  { key: 'textToVideo', label: '文生视频', icon: 'video', desc: '文字描述直接生成视频片段。', example: '可灵 · 即梦 · Runway · Luma' },
  { key: 'imageToVideo', label: '图生视频', icon: 'video', desc: '静态图片驱动生成视频（首帧驱动）。', example: '可灵 · 即梦 · Runway' },
]

interface Draft {
  baseUrl: string
  model: string
  apiKey: string
}

function CapabilityCard({ spec, view }: { spec: CapabilitySpec; view?: MediaApiView }) {
  const [draft, setDraft] = useState<Draft>({ baseUrl: view?.baseUrl ?? '', model: view?.model ?? '', apiKey: '' })
  const [saved, setSaved] = useState(false)
  const dirty = draft.baseUrl !== (view?.baseUrl ?? '') || draft.model !== (view?.model ?? '') || draft.apiKey !== ''

  const save = async (): Promise<void> => {
    await actions.saveMediaApi(spec.key, { baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey, keepApiKey: !draft.apiKey })
    setDraft((d) => ({ ...d, apiKey: '' }))
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const clear = async (): Promise<void> => {
    await actions.clearMediaApi(spec.key)
    setDraft({ baseUrl: '', model: '', apiKey: '' })
  }

  return (
    <div className="media-api-card">
      <div className="ctx-title-row">
        <Icon name={spec.icon} size={15} />
        <span>{t(spec.label)}</span>
        {view?.hasApiKey ? <span className="badge">已配置</span> : <span className="badge badge-muted">未配置</span>}
      </div>
      <p className="hint-line">{t(spec.desc)}{view?.apiKeyHint ? ` 密钥：${view.apiKeyHint}` : ''}</p>
      <p className="hint-line media-api-example">{t(spec.example)}</p>
      <div className="field">
        <span>接口地址（Base URL）</span>
        <input value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
      </div>
      <div className="field">
        <span>模型名</span>
        <input value={draft.model} placeholder="例如 cogview-4" onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
      </div>
      <div className="field">
        <span>API Key（留空 = 不修改{view?.apiKeyHint ? `，当前 ${view.apiKeyHint}` : ''}）</span>
        <input type="password" value={draft.apiKey} placeholder="sk-…" onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
      </div>
      <div className="settings-page-actions">
        <button className="btn" disabled={!view?.hasApiKey && !dirty} onClick={() => void clear()}><Icon name="trash" size={14} />清除</button>
        <div className="spacer" />
        {saved ? <span className="saved-hint" role="status"><Icon name="check" size={14} />已保存</span> : null}
        <button className="btn btn-primary" disabled={!dirty} onClick={() => void save()}><Icon name="check" size={14} />保存</button>
      </div>
    </div>
  )
}

/** 媒体 API 配置页：文生图/图生图/文生音频/语音识别/文生视频/图生视频 六能力的调用配置 */
export function MediaApiPage() {
  const { mediaApis } = useApp()
  return (
    <div className="settings-page">
      <h2>媒体 API</h2>
      <p className="hint-line">
        为各类媒体生成能力配置 API 调用方法：接口地址、模型名和密钥。密钥加密存储在本机，只在调用对应能力时使用；
        未配置的能力对应功能保持不可用。视频模式的生图、语音识别等工具将读取这里的配置。
      </p>
      {CAPABILITIES.map((spec) => (
        <CapabilityCard key={spec.key} spec={spec} view={mediaApis[spec.key]} />
      ))}
    </div>
  )
}
