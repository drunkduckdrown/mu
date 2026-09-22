/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { autoCheck, manualCheck } = vi.hoisted(() => ({ autoCheck: vi.fn(), manualCheck: vi.fn() }));

vi.mock('@/common', () => ({
  ipcBridge: {
    autoUpdate: { check: { invoke: autoCheck } },
    update: { check: { invoke: manualCheck } },
  },
}));

import type { TFunction } from 'i18next';
import { describeUpdateError, runUpdateCheck } from '@/renderer/components/settings/checkForUpdatesShared';

const opts = { includePrerelease: false, fallbackVersion: '0.0.0' };

describe('runUpdateCheck downgrade guard', () => {
  beforeEach(() => {
    autoCheck.mockReset();
    manualCheck.mockReset();
  });

  it('does not offer an older auto-update version as available', async () => {
    // Installed 2.1.54, auto-updater reports an older 2.1.53 feed version.
    autoCheck.mockResolvedValue({ success: true, data: { updateInfo: { version: '2.1.53' } } });
    manualCheck.mockResolvedValue({
      success: true,
      data: { currentVersion: '2.1.54', updateAvailable: false, latest: { version: '2.1.53', htmlUrl: '' } },
    });

    const outcome = await runUpdateCheck(opts);

    expect(outcome.kind).toBe('upToDate');
  });

  it('does not offer an older manual version even when updateAvailable is true', async () => {
    // Defense-in-depth: backend flag says available but version is a downgrade.
    autoCheck.mockResolvedValue({ success: true, data: {} });
    manualCheck.mockResolvedValue({
      success: true,
      data: { currentVersion: '2.1.54', updateAvailable: true, latest: { version: '2.1.53', htmlUrl: '' } },
    });

    const outcome = await runUpdateCheck(opts);

    expect(outcome.kind).toBe('upToDate');
  });

  it('offers a strictly newer version as available', async () => {
    autoCheck.mockResolvedValue({ success: true, data: { updateInfo: { version: '2.1.55' } } });
    manualCheck.mockResolvedValue({
      success: true,
      data: { currentVersion: '2.1.54', updateAvailable: true, latest: { version: '2.1.55', htmlUrl: 'https://x' } },
    });

    const outcome = await runUpdateCheck(opts);

    expect(outcome.kind).toBe('available');
    if (outcome.kind === 'available') {
      expect(outcome.autoUpdateAvailable).toBe(true);
      expect(outcome.updateInfo?.version).toBe('2.1.55');
    }
  });
});

describe('runUpdateCheck failures', () => {
  beforeEach(() => {
    autoCheck.mockReset();
    manualCheck.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns the reason code, not the raw message, for the page to translate', async () => {
    autoCheck.mockResolvedValue({ success: true, data: {} });
    manualCheck.mockResolvedValue({ success: false, msg: 'getaddrinfo ENOTFOUND', errorInfo: { code: 'network' } });

    const outcome = await runUpdateCheck(opts);

    expect(outcome).toEqual({ kind: 'error', error: { code: 'network' }, detail: 'getaddrinfo ENOTFOUND' });
  });

  it('reports an unknown failure when the bridge itself throws', async () => {
    autoCheck.mockResolvedValue({ success: true, data: {} });
    manualCheck.mockRejectedValue(new Error('bridge down'));

    const outcome = await runUpdateCheck(opts);

    expect(outcome).toEqual({ kind: 'error', detail: 'bridge down' });
  });
});

describe('describeUpdateError', () => {
  const t = ((key: string, options?: Record<string, unknown>) =>
    options && (options.status || options.host)
      ? `${key}|${String(options.status || options.host)}`
      : key) as TFunction;

  it('maps each reported cause to its translated text', () => {
    expect(describeUpdateError(t, { code: 'network' }, 'update.checkFailed')).toBe('update.errors.network');
    expect(describeUpdateError(t, { code: 'serverError', status: 503 }, 'update.checkFailed')).toBe(
      'update.errors.serverError|503'
    );
    expect(describeUpdateError(t, { code: 'hostNotAllowed', host: 'evil.test' }, 'update.downloadFailed')).toBe(
      'update.errors.hostNotAllowed|evil.test'
    );
    expect(describeUpdateError(t, { code: 'prepareInstallTimeout' }, 'update.downloadFailed')).toBe(
      'update.errors.prepareInstallTimeout'
    );
  });

  it('names what failed when the cause is unknown or missing', () => {
    expect(describeUpdateError(t, { code: 'unknown' }, 'update.checkFailed')).toBe('update.checkFailed');
    expect(describeUpdateError(t, undefined, 'update.downloadStartFailed')).toBe('update.downloadStartFailed');
  });
});
