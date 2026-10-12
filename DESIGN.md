---
name: Linear Design System
style: dark, minimal, keyboard-first productivity tool
colors:
  primary: "#5E6AD2"
  primary-hover: "#4F5BBD"
  background: "#161618"
  surface: "#1F1F21"
  surface-raised: "#2A2A2C"
  border: "#2F2F31"
  border-subtle: "#232325"
  text-primary: "#F4F4F5"
  text-secondary: "#9B9BA4"
  text-muted: "#62626A"
  success: "#4CAF76"
  error: "#E5534B"
  warning: "#D98D30"
  tag-purple: "#5E6AD2"
  tag-green: "#4CAF76"
  tag-orange: "#D98D30"
  tag-red: "#E5534B"
typography:
  heading: "-apple-system, BlinkMacSystemFont, Inter, sans-serif"
  body: "-apple-system, BlinkMacSystemFont, Inter, sans-serif"
  mono: "JetBrains Mono, Fira Code, monospace"
  scale:
    h1: "1.5rem / 600"
    h2: "1.125rem / 600"
    h3: "0.9375rem / 600"
    body: "0.875rem / 400"
    small: "0.8125rem / 400"
spacing:
  base: "4px"
  scale: "2, 4, 6, 8, 12, 16, 20, 24, 32"
radius:
  button: "6px"
  card: "8px"
  input: "6px"
  tag: "4px"
  avatar: "50%"
---

# Linear Design System

## Visual direction

Linear is a focused, dark-mode-first productivity tool. The UI is extremely minimal — almost invisible — so users focus entirely on content. Use near-black backgrounds, subtle borders, and a single muted indigo as the only real accent color. Spacing is compact. Every interaction is snappy and precise.

## Layout

- Sidebar: 240px, `#161618`, 1px right border `#2F2F31`
- Main content: fills remaining space, `#161618` background
- Issue/page view: max-width 720px centered for readability
- Toolbar / command bar: full-width, `#1F1F21` bg, 48px height
- Compact density: row heights around 32–36px

## Components

### Buttons

```
Primary:   bg-[#5E6AD2] text-white px-3 py-1.5 rounded-[6px] text-[0.875rem] font-medium
           hover:bg-[#4F5BBD] transition-colors
Secondary: bg-[#2A2A2C] text-[#F4F4F5] border border-[#2F2F31] px-3 py-1.5 rounded-[6px] text-[0.875rem]
Ghost:     text-[#9B9BA4] hover:text-[#F4F4F5] hover:bg-[#2A2A2C] px-2 py-1 rounded-[6px]
Danger:    bg-[#E5534B] text-white px-3 py-1.5 rounded-[6px] text-[0.875rem] font-medium
```

- Buttons are compact — 32px height standard
- Icon buttons: 28px square, ghost style by default
- No gradients, no heavy shadows

### Cards and panels

```
Base card:   bg-[#1F1F21] border border-[#2F2F31] rounded-[8px]
Raised card: bg-[#2A2A2C] border border-[#2F2F31] rounded-[8px]
Panel:       bg-[#1F1F21] border-r border-[#2F2F31]
```

- Internal padding: 16px for content cards, 12px for compact list items
- No external shadows — borders only
- Hover state: `#2A2A2C` background

### Lists and issue rows

```
Row:        h-8 flex items-center px-3 text-[0.875rem] text-[#F4F4F5]
            hover:bg-[#1F1F21] rounded-[6px] cursor-pointer
Active row: bg-[#2A2A2C]
```

- Status indicators: small colored dot (6px), not text badges
- Priority icons: colored, 14px, left of title
- Assignee: avatar 20px at right edge of row

### Inputs and forms

```
Input: bg-[#1F1F21] border border-[#2F2F31] rounded-[6px] px-3 py-1.5
       text-[0.875rem] text-[#F4F4F5] placeholder-[#62626A]
       focus:border-[#5E6AD2] focus:ring-1 focus:ring-[#5E6AD2]/40 outline-none
```

- No visible labels in compact forms — use placeholders
- Full labels only in settings or multi-field forms
- Error: `border-[#E5534B]`

### Tags and status

```
Tag: bg-[#2A2A2C] text-[#9B9BA4] rounded-[4px] px-2 py-0.5 text-[0.75rem] font-medium
Status in progress: text-[#5E6AD2] + indigo dot
Status done:        text-[#4CAF76] + green dot
Status blocked:     text-[#E5534B] + red dot
Status backlog:     text-[#62626A] + muted dot
```

### Navigation sidebar

```
Section header:  text-[0.75rem] text-[#62626A] font-medium uppercase px-3 py-1 mt-4
Nav item:        text-[0.875rem] text-[#9B9BA4] px-3 py-1.5 rounded-[6px] flex items-center gap-2
Nav item active: text-[#F4F4F5] bg-[#2A2A2C]
Nav item hover:  text-[#F4F4F5] bg-[#1F1F21]
```

## Spacing rules

- 2–4px between icon and label
- 8px between items in a list group
- 16px between sections within a panel
- 24px between major sections
- No margin-bottom on last child

## Do

- Default to dark mode — `#161618` is the base background
- Use `#9B9BA4` for secondary text — readable but not primary
- Use borders (`#2F2F31`) instead of shadows for depth
- Keep rows tight at 32–36px height
- Use the status dot pattern instead of text badges for status indicators
- Monospace font for issue IDs, code, and technical identifiers

## Don't

- Don't use white backgrounds anywhere
- Don't use heavy shadows — Linear uses no `box-shadow` for elevation
- Don't use rounded-full for buttons — keep at 6px
- Don't use bright accent colors beyond the defined tokens
- Don't add decorative elements — this is a tool, not a marketing page
- Don't use large text — max heading is 1.5rem

## Agent instructions

Apply this design system to all UI in this project. When generating components:

1. All backgrounds must use the dark color palette — no light mode defaults
2. Use `#2F2F31` borders, not Tailwind `border-gray-*` utilities
3. Prefer ghost/icon buttons over labeled buttons in toolbars
4. Status indicators are always a colored dot + label, not a badge
5. Rows and list items get hover state `bg-[#1F1F21]` and active state `bg-[#2A2A2C]`
6. Keep everything compact — when in doubt, reduce padding by 4px


---

## StableWorker desktop application

Downloaded on 2026-10-12 from [Dima Braven's Linear-inspired reference](https://github.com/dimabraven/design-md/blob/f74ca151f92af178f1e0b93f2191e5ec77b33203/examples/linear.md), under the [MIT license](docs/design/linear-LICENSE). This is a community reference based on publicly observable Linear design, not an official Linear specification. The source above is preserved; the following adaptations apply to StableWorker.

- One design system covers the main window, all eight settings pages, API inspector, context manager, search, popovers, approval cards, and tool questions. Shared tokens live in `src/renderer/src/styles.css`; all outline icons come from `components/Icon.tsx`.
- Use the source background, surface, border, primary and state colors. Secondary text stays `#9B9BA4`; muted text uses `#85858F` for readable Chinese labels. Links use a lighter indigo `#A4ACF5`. Use semantic CSS variables rather than inline color literals.
- Native window frames use the dark system theme and the same `#161618` background. Keep native window controls and platform behavior. Utility windows share a branded header, title, description, and compact actions.
- Main and utility toolbars are at least 48px high. The sidebar defaults to 240px and stays resizable. Conversation and composer share a centered 780px maximum reading column, with 24px minimum gutters. Settings use a 196px navigation rail and an independently scrolling content pane.
- Use the local system sans-serif stack with Chinese fallbacks. Technical values, JSON, paths and code use the shared monospace stack; no downloaded fonts or new UI framework.
- Controls are 32px high, toolbar controls 28px, rows 32–36px. Buttons and inputs use 6px corners, panels and popovers 8px. Cards use borders for depth; gradients, blur and decorative shadows are removed.
- Keep full form labels in settings, and accessible names on icon buttons. Every keyboard control has a visible focus indicator. Dialogs close with Escape, contain keyboard focus and restore it on dismissal. Respect reduced-motion preferences.
- Use a consistent colored dot and text for state. Diff, alerts, context segments and approval gates use the existing semantic colors with subtle backgrounds. Context charts use indigo, secondary gray and green with explicit text labels.
- Narrow or short windows must preserve scrolling. Toolbars may wrap; wide price grids scroll horizontally. Markdown previews share chat typography, list indentation, code blocks and tables.

### Validation

Run `npm run typecheck`, `npm test`, and `npm run build`. Visually inspect the main empty/chat states, eight settings pages, popovers and three utility windows at regular and minimum sizes. Verify result-list scrolling, Markdown preview, tool-question cards, visible keyboard focus and dialog dismissal.

Verified on 2026-10-12: type checking, production build and all 87 existing tests passed. Electron rendering checks with isolated sample data covered all eight settings pages, model editor, empty/chat views, approval/question cards, dialog keyboard focus, 50 scrolling search results, Markdown preview, and all four windows at their minimum sizes. These checks use sample IPC responses and do not validate live model services or operating systems other than macOS.

Preview screenshots (sample data): [main workspace](docs/design/preview-main.png), [settings](docs/design/preview-settings.png).
