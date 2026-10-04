/**
 * 功能入口注册表。
 * 新增功能时在这里登记一条（id / 名称 / 说明），它就会自动出现在
 * "设置 → 功能开关"页面里，用户可以自由隐藏或显示对应的入口；
 * 侧栏等处根据配置里的显隐状态渲染（默认显示）。
 */
export interface FeatureDef {
  id: string
  label: string
  description: string
}

export const FEATURE_DEFS: FeatureDef[] = [
  {
    id: 'apiInspector',
    label: 'API 调试',
    description: '左侧栏"🔍 API 调试"入口：查看每次调用的原始请求/响应、用量与费用',
  },
]
