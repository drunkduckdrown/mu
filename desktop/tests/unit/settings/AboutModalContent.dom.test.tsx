/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quitAndInstallMock: vi.fn(),
  autoUpdateCheckMock: vi.fn(),
  updateCheckMock: vi.fn(),
  messageInfoMock: vi.fn(),
  messageErrorMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      key === 'update.preparingInstall'
        ? '准备安装...'
        : key === 'settings.updateReadyInstall'
          ? `${params?.version} 已就绪, 立即安装`
          : key === 'update.currentVersion'
            ? `当前版本：${params?.version}`
            : key,
  }),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: { ...actual.Message, info: mocks.messageInfoMock, error: mocks.messageErrorMock },
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    autoUpdate: {
      quitAndInstall: {
        invoke: mocks.quitAndInstallMock,
      },
      check: { invoke: mocks.autoUpdateCheckMock },
    },
    update: {
      check: { invoke: mocks.updateCheckMock },
    },
  },
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  openExternalUrl: vi.fn(),
}));

vi.mock('@/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'modal',
}));

import AboutModalContent from '@/renderer/components/settings/SettingsModal/contents/AboutModalContent';
import { setUpdateReadyState } from '@/renderer/components/settings/updateReadyState';

describe('AboutModalContent update ready state', () => {
  beforeEach(() => {
    vi.stubGlobal('__APP_VERSION__', '2.1.13');
    vi.stubGlobal('__MU_VERSION__', '0.1.0');
    mocks.quitAndInstallMock.mockResolvedValue(undefined);
    mocks.autoUpdateCheckMock.mockResolvedValue({ success: true });
    mocks.updateCheckMock.mockResolvedValue({
      success: true,
      data: { currentVersion: '2.1.13', updateAvailable: false, latest: null },
    });
  });

  afterEach(() => {
    setUpdateReadyState({ ready: false, version: '' });
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows mu's own version, not the fork's, once: on the row that checks for updates", () => {
    render(<AboutModalContent />);
    expect(screen.getByTestId('about-version')).toHaveTextContent('当前版本：v0.1.0');
    expect(screen.queryByText(/2\.1\.13/)).toBeNull();
  });

  it('replaces check update with ready-to-install when an update package is ready', async () => {
    render(<AboutModalContent />);

    expect(screen.getByRole('button', { name: 'settings.checkForUpdates' })).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('aionui-update-ready-state-changed', {
          detail: {
            ready: true,
            version: '2.1.14',
          },
        })
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: '2.1.14 已就绪, 立即安装' }));

    expect(mocks.quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it('shows preparing loading state for ready auto-update install from About', async () => {
    let rejectInstall!: (error: Error) => void;
    mocks.quitAndInstallMock.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInstall = reject;
        })
    );

    render(<AboutModalContent />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('aionui-update-ready-state-changed', {
          detail: {
            ready: true,
            version: '2.1.14',
          },
        })
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: '2.1.14 已就绪, 立即安装' }));

    expect(await screen.findByRole('button', { name: '准备安装...' })).toBeDisabled();
    expect(mocks.quitAndInstallMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectInstall(new Error('prepare failed'));
    });

    expect(await screen.findByRole('button', { name: '2.1.14 已就绪, 立即安装' })).not.toBeDisabled();
  });

  it('reveals the notification card only when an update is available, with no toast', async () => {
    mocks.updateCheckMock.mockResolvedValue({
      success: true,
      data: {
        currentVersion: '2.1.13',
        updateAvailable: true,
        latest: {
          tagName: 'v2.1.14',
          version: '2.1.14',
          name: 'v2.1.14',
          body: 'notes',
          htmlUrl: 'https://example.com/r',
          prerelease: false,
          draft: false,
          assets: [],
        },
      },
    });
    const availableListener = vi.fn();
    window.addEventListener('aionui-update-available', availableListener);

    render(<AboutModalContent />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.checkForUpdates' }));

    await waitFor(() => {
      expect(availableListener).toHaveBeenCalledTimes(1);
    });
    const detail = (availableListener.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.kind).toBe('available');
    expect(detail.updateInfo.version).toBe('2.1.14');
    expect(mocks.messageInfoMock).not.toHaveBeenCalled();

    window.removeEventListener('aionui-update-available', availableListener);
  });

  it('opens the log folder from About, and says so when it cannot', async () => {
    const openLogFolder = vi.fn(() => Promise.reject(new Error('denied')));
    Object.assign(window, { electronAPI: { openLogFolder } });
    try {
      render(<AboutModalContent />);
      fireEvent.click(screen.getByRole('button', { name: 'common.backendStartup.openLogs' }));
      expect(openLogFolder).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(mocks.messageErrorMock).toHaveBeenCalledWith('common.backendStartup.openLogsFailed');
      });
    } finally {
      delete (window as { electronAPI?: unknown }).electronAPI;
    }
  });

  it('offers no log folder where there is none to open', () => {
    render(<AboutModalContent />);
    expect(screen.queryByRole('button', { name: 'common.backendStartup.openLogs' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.updateLog' })).toBeInTheDocument();
  });

  it('shows an up-to-date toast and no card when there is no update', async () => {
    const availableListener = vi.fn();
    window.addEventListener('aionui-update-available', availableListener);

    render(<AboutModalContent />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.checkForUpdates' }));

    await waitFor(() => {
      expect(mocks.messageInfoMock).toHaveBeenCalledWith('update.alreadyLatest');
    });
    expect(availableListener).not.toHaveBeenCalled();

    window.removeEventListener('aionui-update-available', availableListener);
  });
});
