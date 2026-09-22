/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { MU_DISPLAY_NAME } from '@/common/kyrn/displayName';
import i18n from '@process/services/i18n';
import type { MenuItemConstructorOptions } from 'electron';
import { Menu, app } from 'electron';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The application menu template. Every visible item carries its own label: Electron's role defaults follow the
 * operating system's language, not the app's. A label keeps the role's behaviour (and its accelerator).
 */
export function buildApplicationMenuTemplate(
  t: Translate,
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';
  const name = MU_DISPLAY_NAME;
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      // macOS always titles this menu with the bundle name; the label only matters elsewhere.
      label: app.name,
      submenu: [
        { role: 'about', label: t('common.menu.about', { name }) },
        { type: 'separator' },
        { role: 'services', label: t('common.menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('common.menu.hide', { name }) },
        { role: 'hideOthers', label: t('common.menu.hideOthers') },
        { role: 'unhide', label: t('common.menu.unhide') },
        { type: 'separator' },
        { role: 'quit', label: t('common.menu.quit', { name }) },
      ],
    });
  }

  template.push({
    label: t('common.menu.edit'),
    submenu: [
      { role: 'undo', label: t('common.menu.undo') },
      { role: 'redo', label: t('common.menu.redo') },
      { type: 'separator' },
      { role: 'cut', label: t('common.menu.cut') },
      { role: 'copy', label: t('common.menu.copy') },
      { role: 'paste', label: t('common.menu.paste') },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle', label: t('common.menu.pasteAndMatchStyle') },
            { role: 'delete', label: t('common.menu.delete') },
            { role: 'selectAll', label: t('common.menu.selectAll') },
          ] as MenuItemConstructorOptions[])
        : ([
            { role: 'delete', label: t('common.menu.delete') },
            { type: 'separator' },
            { role: 'selectAll', label: t('common.menu.selectAll') },
          ] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: t('common.menu.view'),
    submenu: [
      { role: 'reload', label: t('common.menu.reload') },
      { role: 'forceReload', label: t('common.menu.forceReload') },
      { role: 'toggleDevTools', label: t('common.menu.toggleDevTools') },
      { type: 'separator' },
      { role: 'resetZoom', label: t('common.menu.resetZoom') },
      { role: 'zoomIn', label: t('common.menu.zoomIn') },
      { role: 'zoomOut', label: t('common.menu.zoomOut') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t('common.menu.toggleFullScreen') },
    ],
  });

  template.push({
    label: t('common.menu.help'),
    // The help role keeps the macOS search field in this menu.
    role: 'help',
    submenu: [
      {
        label: t('common.menu.checkForUpdates'),
        click: () => {
          ipcBridge.update.open.emit({ source: 'menu' });
        },
      },
    ],
  });

  return template;
}

/** Build and install the application menu in the current app language; called again on every language switch. */
export function setupApplicationMenu(): void {
  const t: Translate = (key, options) => i18n.t(key, options);
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(t)));
}
