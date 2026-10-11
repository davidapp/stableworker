import { useCallback, useEffect, useState } from 'react'
import type { MCPServerConfig, McpResourceContent, McpResourceMeta, McpServerStatus } from '../../../../shared/types'

interface Draft {
  type: 'stdio' | 'http'
  name: string
  command: string
  url: string
  envText: string
  headersText: string
  originalName: string
  isNew: boolean
}

interface ResourcePanel {
  server: string
  loading: boolean
  error?: string
  items: McpResourceMeta[]
  readingUri?: string
  content?: string
  contentError?: string
}

const EXAMPLE_STDIO = 'npx -y @modelcontextprotocol/server-filesystem C:\\some\\path'
const EXAMPLE_HTTP = 'http://127.0.0.1:3000/mcp'

/** 把多行 KEY=VALUE 文本解析成对象（# 开头的行忽略） */
function parseKV(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq <= 0) continue
    out[s.slice(0, eq).trim()] = s.slice(eq + 1).trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function kvToText(kv: Record<string, string> | undefined): string {
  return Object.entries(kv ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/** MCP 服务器页：管理服务器列表（stdio / Streamable HTTP），保存即连接；工具以 mcp__服务器__工具 并入工具池 */
export function McpPage() {
  const [servers, setServers] = useState<MCPServerConfig[]>([])
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [panel, setPanel] = useState<ResourcePanel | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const r = await window.api.getMcpAll()
    setServers(r.servers)
    setStatus(r.status)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const statusOf = (name: string): McpServerStatus | undefined => status.find((s) => s.name === name)

  const statusBadge = (s: MCPServerConfig): string => {
    if (s.disabled) return '⏸ 已停用'
    const st = statusOf(s.name)
    if (!st) return '· 未连接'
    const kind = st.kind === 'http' ? 'HTTP' : 'stdio'
    if (st.status === 'connected') return `✅ 已连接（${kind}）· ${st.toolCount} 个工具`
    return `❌ ${st.error ?? '连接失败'}`
  }

  const endpointOf = (s: MCPServerConfig): string => s.url ?? s.command ?? ''

  const persist = async (list: MCPServerConfig[]): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const r = await window.api.saveMcpServers(list)
      setServers(r.servers)
      setStatus(r.status)
      const failed = r.status.filter((s) => s.status === 'error')
      setNotice(failed.length > 0 ? `⚠ 已保存，但 ${failed.map((f) => f.name).join('、')} 连接失败` : '✅ 已保存并连接')
    } finally {
      setBusy(false)
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      setNotice('❌ 名称不能为空')
      return
    }
    const cfg: MCPServerConfig = { name, disabled: false }
    if (draft.type === 'http') {
      cfg.url = draft.url.trim()
      const headers = parseKV(draft.headersText)
      if (headers) cfg.headers = headers
      if (!cfg.url) {
        setNotice('❌ 服务器地址（URL）不能为空')
        return
      }
    } else {
      cfg.command = draft.command.trim()
      const env = parseKV(draft.envText)
      if (env) cfg.env = env
      if (!cfg.command) {
        setNotice('❌ 启动命令不能为空')
        return
      }
    }
    if (servers.some((s) => s.name === name && s.name !== draft.originalName)) {
      setNotice('❌ 已存在同名服务器')
      return
    }
    const list = draft.isNew
      ? [...servers, cfg]
      : servers.map((s) => (s.name === draft.originalName ? cfg : s))
    setDraft(null)
    await persist(list)
  }

  const toggleDisabled = async (s: MCPServerConfig): Promise<void> => {
    await persist(servers.map((x) => (x.name === s.name ? { ...x, disabled: !x.disabled } : x)))
  }

  const remove = async (s: MCPServerConfig): Promise<void> => {
    if (!window.confirm(`删除 MCP 服务器 ${s.name}？其全部工具将从工具池移除。`)) return
    if (panel?.server === s.name) setPanel(null)
    await persist(servers.filter((x) => x.name !== s.name))
  }

  const reconnect = async (name: string): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      setStatus(await window.api.reconnectMcp(name))
    } finally {
      setBusy(false)
    }
  }

  const openResources = async (name: string): Promise<void> => {
    if (panel?.server === name) {
      setPanel(null)
      return
    }
    setPanel({ server: name, loading: true, items: [] })
    const r = await window.api.listMcpResources(name)
    setPanel(r.ok ? { server: name, loading: false, items: r.resources } : { server: name, loading: false, items: [], error: r.error })
  }

  const readResource = async (name: string, uri: string): Promise<void> => {
    setPanel((p) => (p ? { ...p, readingUri: uri, content: undefined, contentError: undefined } : p))
    const r = await window.api.readMcpResource(name, uri)
    setPanel((p) =>
      p && p.server === name
        ? r.ok
          ? { ...p, readingUri: undefined, content: r.contents.map((c: McpResourceContent) => c.text).join('\n') }
          : { ...p, readingUri: undefined, contentError: r.error }
        : p,
    )
  }

  const editDraft = (s: MCPServerConfig): Draft => ({
    type: s.url ? 'http' : 'stdio',
    name: s.name,
    command: s.command ?? '',
    url: s.url ?? '',
    envText: kvToText(s.env),
    headersText: kvToText(s.headers),
    originalName: s.name,
    isNew: false,
  })

  return (
    <div className="settings-page">
      <h2>MCP 服务器</h2>
      <p className="hint-line">
        Model Context Protocol：接入外部工具服务器（支持 stdio 与 Streamable HTTP 两种传输），
        其工具以 <code className="tool-switch-name">mcp__服务器名__工具名</code> 并入工具池。
        默认每次调用需批准；规划模式下不可用。进程意外退出会自动重连（5s/15s/30s 退避）。
      </p>

      {draft ? (
        <>
          <div className="field">
            <span>传输方式</span>
            <div>
              <label style={{ marginRight: 16 }}>
                <input
                  type="radio"
                  checked={draft.type === 'stdio'}
                  onChange={() => setDraft({ ...draft, type: 'stdio' })}
                />{' '}
                stdio（本机启动子进程）
              </label>
              <label>
                <input
                  type="radio"
                  checked={draft.type === 'http'}
                  onChange={() => setDraft({ ...draft, type: 'http' })}
                />{' '}
                Streamable HTTP（远程服务器）
              </label>
            </div>
          </div>
          <div className="field">
            <span>服务器名（用于工具命名 mcp__名称__工具）</span>
            <input
              value={draft.name}
              placeholder="例如 filesystem"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          {draft.type === 'stdio' ? (
            <>
              <div className="field">
                <span>启动命令（完整命令行，支持双引号包裹含空格的参数）</span>
                <input
                  value={draft.command}
                  placeholder={EXAMPLE_STDIO}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                />
              </div>
              <div className="field">
                <span>环境变量（可选，每行 KEY=VALUE）</span>
                <textarea
                  className="holidays-input"
                  rows={3}
                  value={draft.envText}
                  placeholder={'API_KEY=sk-xxx\nDEBUG=1'}
                  onChange={(e) => setDraft({ ...draft, envText: e.target.value })}
                />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <span>服务器地址（Streamable HTTP 端点）</span>
                <input
                  value={draft.url}
                  placeholder={EXAMPLE_HTTP}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                />
              </div>
              <div className="field">
                <span>请求头（可选，每行 KEY=VALUE，如 Authorization）</span>
                <textarea
                  className="holidays-input"
                  rows={3}
                  value={draft.headersText}
                  placeholder={'Authorization=Bearer sk-xxx'}
                  onChange={(e) => setDraft({ ...draft, headersText: e.target.value })}
                />
              </div>
            </>
          )}
          <div className="settings-page-actions">
            <button className="btn" onClick={() => setDraft(null)}>
              取消
            </button>
            <div className="spacer" />
            <button className="btn btn-primary" disabled={busy} onClick={() => void saveDraft()}>
              保存并连接
            </button>
          </div>
        </>
      ) : (
        <>
          {servers.length === 0 ? (
            <div className="profile-empty">还没有配置 MCP 服务器。点下面"＋ 新增服务器"添加。</div>
          ) : (
            <div className="profile-list">
              {servers.map((s) => (
                <div key={s.name}>
                  <div className="profile-row">
                    <div className="profile-info">
                      <span className="profile-name">
                        <code className="tool-switch-name">{s.name}</code>
                      </span>
                      <small>{endpointOf(s)}</small>
                      <small>
                        {statusBadge(s)}
                        {s.env ? ' · env' : ''}
                        {s.headers ? ' · headers' : ''}
                      </small>
                    </div>
                    <div className="profile-actions">
                      {!s.disabled ? (
                        <>
                          <button className="btn" disabled={busy} onClick={() => void reconnect(s.name)}>
                            重连
                          </button>
                          <button className="btn" onClick={() => void openResources(s.name)}>
                            {panel?.server === s.name ? '收起资源' : '资源'}
                          </button>
                        </>
                      ) : null}
                      <button className="btn" disabled={busy} onClick={() => void toggleDisabled(s)}>
                        {s.disabled ? '启用' : '停用'}
                      </button>
                      <button className="btn" onClick={() => setDraft(editDraft(s))}>
                        编辑
                      </button>
                      <button className="btn btn-danger-ghost" disabled={busy} onClick={() => void remove(s)}>
                        删除
                      </button>
                    </div>
                  </div>
                  {panel?.server === s.name ? (
                    <div style={{ margin: '4px 0 10px 12px', padding: '8px 10px', border: '1px solid var(--border, #333)', borderRadius: 8 }}>
                      {panel.loading ? <small>读取资源列表…</small> : null}
                      {panel.error ? <small>❌ {panel.error}</small> : null}
                      {!panel.loading && !panel.error && panel.items.length === 0 ? (
                        <small>该服务器没有暴露资源（或未实现 resources）。</small>
                      ) : null}
                      {panel.items.map((r) => (
                        <div key={r.uri} style={{ margin: '2px 0' }}>
                          <button
                            className="btn"
                            style={{ fontSize: 12 }}
                            disabled={panel.readingUri === r.uri}
                            title={r.description ?? r.uri}
                            onClick={() => void readResource(s.name, r.uri)}
                          >
                            {panel.readingUri === r.uri ? '读取中…' : `📄 ${r.name ?? r.uri}`}
                          </button>
                        </div>
                      ))}
                      {panel.contentError ? <small>❌ {panel.contentError}</small> : null}
                      {panel.content !== undefined ? (
                        <>
                          <textarea className="holidays-input" rows={6} readOnly value={panel.content} />
                          <button className="btn" style={{ marginTop: 4 }} onClick={() => void navigator.clipboard.writeText(panel.content ?? '')}>
                            复制内容
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <div className="settings-page-actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                setDraft({
                  type: 'stdio',
                  name: '',
                  command: '',
                  url: '',
                  envText: '',
                  headersText: '',
                  originalName: '',
                  isNew: true,
                })
              }
            >
              ＋ 新增服务器
            </button>
            <div className="spacer" />
            {notice ? <span className="saved-hint">{notice}</span> : null}
          </div>
        </>
      )}
    </div>
  )
}
