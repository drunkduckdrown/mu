/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common/platform/bridge', () => ({
  bridge: {
    buildProvider: vi.fn(() => {
      const handlerMap = new Map<string, Function>();
      return {
        provider: vi.fn((handler: Function) => {
          handlerMap.set('handler', handler);
          return vi.fn();
        }),
        invoke: vi.fn(),
        _getHandler: () => handlerMap.get('handler'),
      };
    }),
    buildEmitter: vi.fn(() => ({
      emit: vi.fn(),
      on: vi.fn(),
    })),
  },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '2.1.40'),
    getPath: vi.fn(() => '/test/path'),
    exit: vi.fn(),
    isPackaged: true,
  },
  autoUpdater: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    setFeedURL: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    transports: { file: { level: 'info' } },
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@process/services/i18n', () => ({
  default: { t: (key: string) => key },
}));

// The fixtures below are mac-arm64 assets and pickRecommendedAsset reads the host platform/arch, so pin the runtime
// to keep results identical on every CI runner.
import { afterAll, beforeAll } from 'vitest';

const realPlatform = process.platform;
const realArch = process.arch;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
});

const asset = (name: string, size: number) => ({
  name,
  browser_download_url: `https://github.com/qybaihe/mu/releases/download/v2.1.45/${name}`,
  size,
});

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: tag,
  body: `notes for ${tag}`,
  html_url: `https://github.com/qybaihe/mu/releases/tag/${tag}`,
  published_at: '2026-09-22T00:00:00Z',
  prerelease: true,
  draft: false,
  assets: [asset(`mu-${tag.slice(1)}-mac-arm64.zip`, 100), asset(`mu-${tag.slice(1)}-mac-arm64.dmg`, 200)],
  ...extra,
});

const getCheckHandler = async () => {
  vi.resetModules();
  const { initUpdateBridge } = await import('@process/bridge/updateBridge');
  const { ipcBridge } = await import('@/common');
  initUpdateBridge();
  const provider = vi.mocked(ipcBridge.update.check.provider);
  const lastCall = provider.mock.calls.at(-1);
  if (!lastCall) throw new Error('update.check handler not registered');
  return lastCall[0];
};

/** Only mu's own release list answers; any other request fails the test. */
const stubFetch = (github: () => Promise<Response> | Response) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/qybaihe/mu/releases') return github();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('update.check against mu’s own releases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers the newest release, pre-releases included, with its notes and the installer for this machine', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse([release('v2.1.44'), release('v2.1.45'), release('v2.1.46', { draft: true }), release('nightly')])
    );
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(true);
    expect(res.data?.latest).toMatchObject({
      version: '2.1.45',
      prerelease: true,
      body: 'notes for v2.1.45',
      htmlUrl: 'https://github.com/qybaihe/mu/releases/tag/v2.1.45',
    });
    expect(res.data?.latest?.recommendedAsset?.url).toBe(
      'https://github.com/qybaihe/mu/releases/download/v2.1.45/mu-2.1.45-mac-arm64.dmg'
    );
    // mu asks nobody but its own repository: never AionUi's update server or AionUi's GitHub.
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.github.com/repos/qybaihe/mu/releases',
    ]);
  });

  it('reports up to date when the newest release is not newer than this build', async () => {
    stubFetch(() => jsonResponse([release('v2.1.40'), release('v2.0.0')]));
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(false);
  });

  it('reports up to date when there is no release yet', async () => {
    stubFetch(() => jsonResponse([]));
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res).toMatchObject({ success: true, data: { currentVersion: '2.1.40', updateAvailable: false } });
  });

  it('fails the check with a reason code when GitHub answers with an error', async () => {
    stubFetch(() => new Response('nope', { status: 502 }));
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(false);
    // A reason code for the renderer to translate; the raw message stays for the log.
    expect(res.errorInfo).toEqual({ code: 'serverError', status: 502 });
    expect(res.msg).toContain('502');
  });

  it('fails the check when the answer is not a release list', async () => {
    stubFetch(() => jsonResponse({ message: 'Not a list' }));
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(false);
    expect(res.errorInfo).toEqual({ code: 'invalidMetadata' });
  });

  it('reports an unreachable update server as a network failure', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
      });
    });
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(false);
    expect(res.errorInfo).toEqual({ code: 'network' });
  });
});
