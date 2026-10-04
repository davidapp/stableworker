import { Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * 应用菜单：自建中文菜单替代 Electron 默认菜单。
 * 注意"编辑"菜单里的 role 项必须保留——它们携带撤销/复制/粘贴等
 * 标准快捷键，去掉会导致输入框无法复制粘贴。
 */
export function createAppMenu(onOpenInspector: () => void): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [{ role: 'close', label: '关闭窗口' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
        { type: 'separator' },
        {
          label: 'API 调试',
          accelerator: 'CmdOrCtrl+Alt+D',
          click: () => onOpenInspector(),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
