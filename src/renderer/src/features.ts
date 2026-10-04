/**
 * 功能入口注册表。
 * 新增功能时在这里登记一条（id / 名称 / 说明），它就会自动出现在
 * "设置 → 功能开关"页面里，用户可以自由隐藏或显示对应的入口。
 *
 * 注：API 调试已移至原生菜单"窗口 → API 调试"（独立悬浮窗口），
 * 不再作为界面内入口登记。
 */
export interface FeatureDef {
  id: string
  label: string
  description: string
}

export const FEATURE_DEFS: FeatureDef[] = []
