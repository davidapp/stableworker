import { useState } from 'react'
import { useApp } from '../../store'
import * as actions from '../../actions'
import { FEATURE_DEFS } from '../../features'

/** 功能开关页：统一管理各功能入口的显示/隐藏 */
export function FeaturesPage() {
  const { features } = useApp()
  // 草稿：id → 是否显示（配置里没有记录的功能默认显示）
  const [draft, setDraft] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(FEATURE_DEFS.map((d) => [d.id, !(features.find((f) => f.id === d.id)?.hidden ?? false)])),
  )
  const [saved, setSaved] = useState(false)

  const toggle = (id: string, shown: boolean): void => setDraft((prev) => ({ ...prev, [id]: shown }))

  const save = async (): Promise<void> => {
    await actions.saveFeatures(
      FEATURE_DEFS.map((d) => ({ id: d.id, label: d.label, hidden: !draft[d.id] })),
    )
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="settings-page">
      <h2>功能开关</h2>
      <p className="hint-line">这里控制各功能入口是否显示；隐藏后随时可以回来重新打开。</p>

      {FEATURE_DEFS.length === 0 ? (
        <div className="profile-empty">
          暂无可开关的功能入口。新功能在 src/renderer/src/features.ts 登记后会出现在这里。
        </div>
      ) : (
        FEATURE_DEFS.map((d) => (
          <div className="features-row" key={d.id}>
            <label className="features-text">
              <span className="features-label">{d.label}</span>
              <small>{d.description}</small>
            </label>
            <label className="features-toggle">
              <input
                type="checkbox"
                checked={draft[d.id] ?? true}
                onChange={(e) => toggle(d.id, e.target.checked)}
              />
              显示
            </label>
          </div>
        ))
      )}

      <div className="settings-page-actions">
        <div className="spacer" />
        {saved ? <span className="saved-hint">✅ 已保存</span> : null}
        <button className="btn btn-primary" onClick={() => void save()}>
          保存
        </button>
      </div>
    </div>
  )
}
