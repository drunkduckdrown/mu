/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { classifyUpdateError, UpdateError, updateErrorDetail } from '@/common/update/updateErrors';

describe('classifyUpdateError', () => {
  it('keeps the code of our own UpdateError', () => {
    const error = new UpdateError({ code: 'hostNotAllowed', host: 'evil.test' }, 'Download host is not allowed');
    expect(classifyUpdateError(error)).toEqual({ code: 'hostNotAllowed', host: 'evil.test' });
    expect(updateErrorDetail(error)).toBe('Download host is not allowed');
  });

  it('finds a network failure in the cause Node fetch hides it in', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND static.aionui.com'), { code: 'ENOTFOUND' });
    expect(classifyUpdateError(new TypeError('fetch failed', { cause }))).toEqual({ code: 'network' });
  });

  it('recognizes Chromium network errors from electron-updater', () => {
    expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toEqual({ code: 'network' });
    expect(
      classifyUpdateError(new Error('Cannot find channel "latest-mac.yml" update info: net::ERR_NAME_NOT_RESOLVED'))
    ).toEqual({ code: 'network' });
  });

  it('tells a timeout apart', () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(classifyUpdateError(abort)).toEqual({ code: 'timeout' });
    expect(classifyUpdateError(new Error('net::ERR_TIMED_OUT'))).toEqual({ code: 'timeout' });
    expect(classifyUpdateError(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toEqual({ code: 'timeout' });
  });

  it('reports a missing update file as no update information', () => {
    expect(
      classifyUpdateError(
        new Error('Cannot find latest-mac.yml in the latest release artifacts (https://x): HttpError: 404')
      )
    ).toEqual({ code: 'noUpdateInfo' });
  });

  it('keeps the HTTP status of other server errors', () => {
    expect(classifyUpdateError(new Error('HttpError: 503 Service Unavailable'))).toEqual({
      code: 'serverError',
      status: 503,
    });
  });

  it('falls back to unknown', () => {
    expect(classifyUpdateError(new Error('something odd'))).toEqual({ code: 'unknown' });
    expect(classifyUpdateError('plain string')).toEqual({ code: 'unknown' });
  });
});
