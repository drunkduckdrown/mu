/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 系统设置桥接模块
 * System Settings Bridge Module
 *
 * 负责���理系统级设置的读写操作（如关闭到托盘）
 * Handles read/write operations for system-level settings (e.g. close to tray)
 */

import { ipcBridge } from '@/common';
import { ProcessConfig } from '@process/utils/initStorage';
import { applyAppLanguage } from '@process/services/i18n';
import type { PetSize } from '@process/pet/petTypes';
import { createOrUpdateTray, destroyTray, setCloseToTrayEnabled } from '@process/utils/tray';
import { readCloseToTraySetting, writeCloseToTraySetting } from '@process/utils/closeToTraySetting';

export function initSystemSettingsBridge(): void {
  ipcBridge.systemSettings.getCloseToTray.provider(async () => readCloseToTraySetting());

  ipcBridge.systemSettings.setCloseToTray.provider(async ({ enabled }) => {
    await writeCloseToTraySetting(enabled);
    setCloseToTrayEnabled(enabled);
    if (enabled) {
      createOrUpdateTray();
    } else {
      destroyTray();
    }
  });

  // The renderer changed the app language: switch the main process's own texts. applyAppLanguage rebuilds the
  // application menu and the tray once i18next is in the new language (see onAppLanguageApplied in index.ts).
  ipcBridge.systemSettings.syncMainLanguage.provider(async ({ language }) => {
    try {
      await applyAppLanguage(language);
    } catch (error) {
      console.error('[SystemSettings] Main process could not switch language:', error);
    }
  });

  // Desktop pet settings
  ipcBridge.systemSettings.getPetEnabled.provider(async () => {
    const value = await ProcessConfig.get('pet.enabled');
    return value ?? false;
  });

  ipcBridge.systemSettings.setPetEnabled.provider(async ({ enabled }) => {
    const { createPetWindow, destroyPetWindow, isPetSupported } = await import('@process/pet/petManager');
    if (enabled && !isPetSupported()) {
      console.warn('[SystemSettings] Desktop pet is not supported in headless mode');
      return;
    }
    await ProcessConfig.set('pet.enabled', enabled);
    if (enabled) {
      createPetWindow();
    } else {
      destroyPetWindow();
    }
  });

  ipcBridge.systemSettings.getPetSize.provider(async () => {
    const value = await ProcessConfig.get('pet.size');
    return value ?? 280;
  });

  ipcBridge.systemSettings.setPetSize.provider(async ({ size }) => {
    await ProcessConfig.set('pet.size', size);
    const { resizePetWindow } = await import('@process/pet/petManager');
    resizePetWindow(size as PetSize);
  });

  ipcBridge.systemSettings.getPetDnd.provider(async () => {
    const value = await ProcessConfig.get('pet.dnd');
    return value ?? false;
  });

  ipcBridge.systemSettings.setPetDnd.provider(async ({ dnd }) => {
    await ProcessConfig.set('pet.dnd', dnd);
    const { setPetDndMode } = await import('@process/pet/petManager');
    setPetDndMode(dnd);
  });

  // Pet confirm-bubble toggle: when disabled, AI tool-call confirmations
  // are not routed to the pet's bubble window. Default true.
  ipcBridge.systemSettings.getPetConfirmEnabled.provider(async () => {
    const value = await ProcessConfig.get('pet.confirmEnabled');
    return value ?? true;
  });

  ipcBridge.systemSettings.setPetConfirmEnabled.provider(async ({ enabled }) => {
    await ProcessConfig.set('pet.confirmEnabled', enabled);
    const { setPetConfirmEnabled } = await import('@process/pet/petManager');
    setPetConfirmEnabled(enabled);
  });
}
