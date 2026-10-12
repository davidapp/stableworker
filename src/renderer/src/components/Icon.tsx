import type { SVGProps } from 'react'

const paths = {
  logo: 'M5 4h14v16H5z M9 8h6 M9 12h6 M9 16h3',
  plus: 'M12 5v14 M5 12h14',
  folder: 'M3 7V5h6l2 2h10v13H3z',
  chat: 'M4 4h16v12H9l-5 4z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  code: 'M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',
  close: 'M6 6l12 12 M6 18L18 6',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  arrowDown: 'M12 4v16 M5 13l7 7 7-7',
  arrowUp: 'M12 20V4 M5 11l7-7 7 7',
  edit: 'M15 4l5 5 M4 20l1-5L16 4a2 2 0 0 1 4 4L9 19z',
  trash: 'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
  warning: 'M12 3L2 21h20z M12 9v5 M12 17v.1',
  brain: 'M12 5c-2-4-7-2-7 2-4 1-4 7 0 8 0 4 5 6 7 2V5z M12 5c2-4 7-2 7 2 4 1 4 7 0 8 0 4-5 6-7 2 M5 7l3 2 M5 15l3-2 M19 7l-3 2 M19 15l-3-2',
  check: 'M5 12l4 4L19 6',
  list: 'M9 6h12 M9 12h12 M9 18h12 M3 6h.1 M3 12h.1 M3 18h.1',
  server: 'M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.1 M7 17.5h.1 M12 6.5h5 M12 17.5h5',
  terminal: 'M3 4h18v16H3z M7 8l4 4-4 4 M13 16h4',
  sliders: 'M4 6h5 M15 6h5 M4 12h9 M19 12h1 M4 18h1 M11 18h9 M9 3v6 M15 9v6 M5 15v6',
  key: 'M8 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10 M12 11l9 9 M17 16l3-3 M14 13l3-3',
  external: 'M14 3h7v7 M21 3L10 14 M10 3H3v18h18v-7',
  copy: 'M8 8h13v13H8z M16 8V3H3v13h5',
  refresh: 'M20 7V3l-4 4 M20 7a8 8 0 1 0 0 10',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
  stop: 'M6 6h12v12H6z',
} as const

export type IconName = keyof typeof paths

/** One local outline icon set shared by every application window. */
export function Icon({ name, size = 16, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d={paths[name]} />
    </svg>
  )
}
