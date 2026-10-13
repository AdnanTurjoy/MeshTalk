import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { Screen } from '../shared/ipc';

/** Platform-appropriate menu; navigation items share accelerators on every OS. */
export function buildMenu(opts: {
  isMac: boolean;
  isDev: boolean;
  appName: string;
  navigate: (screen: Screen) => void;
  lock: () => void;
}): Menu {
  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => opts.navigate('settings'),
  };
  const nav = (label: string, accelerator: string, screen: Screen): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => opts.navigate(screen),
  });
  const navItems: MenuItemConstructorOptions[] = [
    nav('Chats', 'CmdOrCtrl+1', 'chats'),
    nav('Calls', 'CmdOrCtrl+2', 'calls'),
    nav('People', 'CmdOrCtrl+3', 'people'),
    nav('Skills', 'CmdOrCtrl+4', 'skills'),
    nav('Files', 'CmdOrCtrl+5', 'files'),
    nav('Network', 'CmdOrCtrl+6', 'network'),
  ];
  const lockItem: MenuItemConstructorOptions = {
    label: 'Lock MeshTalk',
    accelerator: 'CmdOrCtrl+L',
    click: opts.lock,
  };
  const diagnosticsItem: MenuItemConstructorOptions = {
    label: 'Diagnostics',
    accelerator: 'CmdOrCtrl+Shift+D',
    click: () => opts.navigate('diagnostics'),
  };

  const template: MenuItemConstructorOptions[] = [
    ...(opts.isMac
      ? [
          {
            label: opts.appName,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settingsItem,
              lockItem,
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : [
          {
            label: 'File',
            submenu: [settingsItem, lockItem, { type: 'separator' }, { role: 'quit' }],
          } satisfies MenuItemConstructorOptions,
        ]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...navItems,
        diagnosticsItem,
        { type: 'separator' },
        ...(opts.isDev
          ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as const)
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}
