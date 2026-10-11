import { useCallback, useEffect, useState } from 'react'
import type { MCPServerConfig, McpServerStatus } from '../../../../shared/types'

interface Draft {
  name: string
  command: string
  isNew: boolean
  originalName: string
}

const EXAMPLE = 'npx -y @modelcontextprotocol/server-filesystem C:\\some\\path'

/** MCP 服务器页：管理 stdio 服务器列表，保存即连接；工具以 mcp__服务器__工具 并入工具池 */
export function McpPage() {
  const [servers, setServers] = useState<MCPServerConfig[]>([])
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

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
    if (st.status === 'connected') return `✅ 已连接 · ${st.toolCount} 个工具`
    return `❌ ${st.error ?? '连接失败'}`
  }

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
    const command = draft.command.trim()
    if (!name || !command) {
      setNotice('❌ 名称与命令行不能为空')
      return
    }
    const clash = servers.some((s) => s.name === name && s.name !== draft.originalName)
    if (clash) {
      setNotice('❌ 已存在同名服务器')
      return
    }
    const list = draft.isNew
      ? [...servers, { name, command }]
      : servers.map((s) => (s.name === draft.originalName ? { ...s, name, command } : s))
    setDraft(null)
    await persist(list)
  }

  const toggleDisabled = async (s: MCPServerConfig): Promise<void> => {
    await persist(servers.map((x) => (x.name === s.name ? { ...x, disabled: !x.disabled } : x)))
  }

  const remove = async (s: MCPServerConfig): Promise<void> => {
    if (!window.confirm(`删除 MCP 服务器 ${s.name}？其全部工具将从工具池移除。`)) return
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

  return (
    <div className="settings-page">
      <h2>MCP 服务器</h2>
      <p className="hint-line">
        Model Context Protocol（stdio 传输）：配置外部工具服务器，其工具以{' '}
        <code className="tool-switch-name">mcp__服务器名__工具名</code> 并入工具池。
        默认每次调用需批准；规划模式下不可用。每轮对话开始时自动按此列表连接。
      </p>

      {draft ? (
        <>
          <div className="field">
            <span>服务器名（用于工具命名 mcp__名称__工具）</span>
            <input
              value={draft.name}
              placeholder="例如 filesystem"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="field">
            <span>启动命令（完整命令行，支持双引号包裹含空格的参数）</span>
            <input
              value={draft.command}
              placeholder={EXAMPLE}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
          </div>
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
                <div className="profile-row" key={s.name}>
                  <div className="profile-info">
                    <span className="profile-name">
                      <code className="tool-switch-name">{s.name}</code>
                    </span>
                    <small>{s.command}</small>
                    <small>{statusBadge(s)}</small>
                  </div>
                  <div className="profile-actions">
                    {!s.disabled ? (
                      <button className="btn" disabled={busy} onClick={() => void reconnect(s.name)}>
                        重连
                      </button>
                    ) : null}
                    <button className="btn" disabled={busy} onClick={() => void toggleDisabled(s)}>
                      {s.disabled ? '启用' : '停用'}
                    </button>
                    <button
                      className="btn"
                      onClick={() => setDraft({ name: s.name, command: s.command, isNew: false, originalName: s.name })}
                    >
                      编辑
                    </button>
                    <button className="btn btn-danger-ghost" disabled={busy} onClick={() => void remove(s)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="settings-page-actions">
            <button className="btn btn-primary" onClick={() => setDraft({ name: '', command: '', isNew: true, originalName: '' })}>
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
