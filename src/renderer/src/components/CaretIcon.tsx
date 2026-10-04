/** 下拉菜单的 chevron 箭头（细线风格，与常见图标库一致） */
export function CaretIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="mode-caret"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}
