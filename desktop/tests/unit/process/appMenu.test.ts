/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  Menu: { buildFromTemplate: vi.fn((template: unknown) => ({ template })), setApplicationMenu: vi.fn() },
  app: { name: 'AionUi' },
}));

vi.mock('electron', () => electron);

import { buildApplicationMenuTemplate, setupApplicationMenu } from '@/process/utils/appMenu';
import i18n, { changeLanguage } from '@/process/services/i18n';

const fakeT = (key: string, options?: Record<string, unknown>) =>
  options?.name ? `${key}(${String(options.name)})` : key;

const visibleItems = (template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? visibleItems(item.submenu as MenuItemConstructorOptions[]) : []),
  ]);

describe('buildApplicationMenuTemplate', () => {
  it('gives every visible item a label from the app language, on macOS', () => {
    const template = buildApplicationMenuTemplate(fakeT, 'darwin');
    const unlabeled = visibleItems(template).filter((item) => item.type !== 'separator' && !item.label);

    expect(unlabeled).toEqual([]);
    const labels = visibleItems(template).map((item) => item.label);
    expect(labels).toContain('common.menu.about(mu)');
    expect(labels).toContain('common.menu.quit(mu)');
    expect(labels).toContain('common.menu.pasteAndMatchStyle');
  });

  it('gives every visible item a label on Windows and Linux too', () => {
    const template = buildApplicationMenuTemplate(fakeT, 'win32');
    const unlabeled = visibleItems(template).filter((item) => item.type !== 'separator' && !item.label);

    expect(unlabeled).toEqual([]);
    expect(template.map((item) => item.label)).toEqual(['common.menu.edit', 'common.menu.view', 'common.menu.help']);
  });

  it('keeps the roles, so labelled items behave as before', () => {
    const template = buildApplicationMenuTemplate(fakeT, 'darwin');
    const roles = visibleItems(template)
      .map((item) => item.role)
      .filter(Boolean);

    expect(roles).toEqual(
      expect.arrayContaining(['about', 'quit', 'undo', 'redo', 'copy', 'paste', 'selectAll', 'reload', 'help'])
    );
  });

  it('builds the installed menu in the main-process language', async () => {
    await changeLanguage('zh-CN');
    setupApplicationMenu();

    const installed = electron.Menu.buildFromTemplate.mock.calls.at(-1)?.[0] as MenuItemConstructorOptions[];
    expect(installed.map((item) => item.label)).toContain('编辑');
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalled();
    await changeLanguage('en-US');
    expect(i18n.t('common.menu.edit')).toBe('Edit');
  });
});
