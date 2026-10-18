import { useState } from 'react'
import { useApp } from '../../store'
import * as actions from '../../actions'

/** 上下文压缩页：micro 压缩的触发比例与保留轮数（应用全局） */
export function MicroCompactPage() {
  const { microCompactRatio, microCompactKeep } = useApp()
  const [ratioText, setRatioText] = useState<string | null>(null)
  const [keepText, setKeepText] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const save = async (): Promise<void> => {
    const ratio = Number.parseFloat(ratioText ?? '')
    const keep = Number.parseInt(keepText ?? '', 10)
    await actions.setMicroCompact(
      Number.isFinite(ratio) ? ratio / 100 : microCompactRatio,
      Number.isFinite(keep) ? keep : microCompactKeep,
    )
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="settings-page">
      <h2>上下文压缩</h2>
      <p className="hint-line">
        对话占用超过上下文上限一定比例时，自动把早期工具结果清成摘要占位（micro 压缩，保留最近几轮完整结果）；
        接近上限时会进一步做整段摘要压缩。触发比例越低越早压缩、更省 token；保留轮数越多上下文越完整。
      </p>

      <div className="field">
        <span>触发比例（占上下文上限的 %，30–80）</span>
        <input
          type="number"
          min="30"
          max="80"
          value={ratioText ?? Math.round((microCompactRatio ?? 0.55) * 100)}
          onChange={(e) => setRatioText(e.target.value)}
        />
      </div>
      <div className="field">
        <span>保留最近助手消息轮数（1–6）</span>
        <input
          type="number"
          min="1"
          max="6"
          value={keepText ?? microCompactKeep ?? 2}
          onChange={(e) => setKeepText(e.target.value)}
        />
      </div>
      <div className="settings-page-actions">
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => void save()}>
          保存
        </button>
      </div>
      {saved ? <span className="saved-hint" role="status">已保存，下一轮对话生效</span> : null}
    </div>
  )
}
