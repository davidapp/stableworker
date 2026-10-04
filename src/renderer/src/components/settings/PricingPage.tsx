import { useState } from 'react'
import { useApp } from '../../store'
import * as actions from '../../actions'
import type { Currency, ModelPricing } from '../../../../shared/types'

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

const HOLIDAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 模型价格页：价格表 + 分时计费的节假日表 */
export function PricingPage() {
  const { modelPricing, holidays } = useApp()
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
  const [holidaysText, setHolidaysText] = useState(() => holidays.join('\n'))
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const updatePricingRow = (index: number, patch: Partial<PricingDraft>): void => {
    setPricing((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const updatePriceCell = (index: number, key: PriceKey, value: string): void => {
    setPricing((rows) =>
      rows.map((r, i) => (i === index ? { ...r, prices: { ...r.prices, [key]: value } } : r)),
    )
  }

  const save = async (): Promise<void> => {
    const holidayList = holidaysText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const bad = holidayList.find((s) => !HOLIDAY_RE.test(s))
    if (bad) {
      setError(`节假日日期格式不正确：${bad}（应为 YYYY-MM-DD，每行一个）`)
      return
    }
    setError('')

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
    await actions.saveHolidays(holidayList)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="settings-page">
      <h2>模型价格</h2>

      <div className="field">
        <span>价格表（本币 / 每百万 tokens，供 API 调试面板精确计费）</span>
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
                model: '',
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
          命中/未命中 = 输入 tokens 的缓存命中与未命中单价；不分时定价的服务商把两档填成一样即可。
          计费按请求发起时刻的北京时间定档：工作日 09:00–12:00、14:00–18:00 为高峰，其余为空闲。
        </small>
      </div>

      <div className="field">
        <span>法定节假日（北京时间，每行一个，格式 YYYY-MM-DD；当天全天空闲计费）</span>
        <textarea
          className="holidays-input"
          rows={6}
          value={holidaysText}
          placeholder={'2026-10-01\n2026-10-02\n…'}
          onChange={(e) => setHolidaysText(e.target.value)}
        />
        <small>以国务院每年发布的放假安排为准；当前共 {holidaysText.split('\n').filter((s) => s.trim()).length} 条。</small>
      </div>

      {error ? <div className="msg-error">{error}</div> : null}

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
