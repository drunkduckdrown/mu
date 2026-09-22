import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import WebviewHost from '@/renderer/components/media/WebviewHost';

const { report } = vi.hoisted(() => ({ report: vi.fn(async () => ({ success: true })) }));
vi.mock('@/common', () => ({
  ipcBridge: { application: { reportBrowserWebContentsId: { invoke: report } } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** jsdom knows no `<webview>`: give the element the few methods WebviewHost calls when the page is ready. */
async function ready(container: HTMLElement) {
  const view = container.querySelector('webview') as HTMLElement & Record<string, unknown>;
  const scripts: string[] = [];
  view.executeJavaScript = vi.fn(async (script: string) => {
    scripts.push(script);
    return true;
  });
  view.getWebContentsId = () => 7;
  view.canGoBack = () => false;
  view.canGoForward = () => false;
  view.setZoomFactor = () => undefined;
  await act(async () => {
    view.dispatchEvent(new Event('dom-ready'));
  });
  return { view, scripts };
}

describe('the two seams agent tabs need in the shared webview host', () => {
  it('by default intercepts links and forms, and reports the page to the single-target bridge', async () => {
    const { container } = render(<WebviewHost url='https://example.com/' />);
    const { scripts } = await ready(container);
    expect(scripts.some((script) => script.includes('__webviewHostInjected'))).toBe(true);
    expect(report).toHaveBeenCalledWith({ webContentsId: 7 });
  });

  it('leaves a pristine page its own links and forms, and hands the webContents to the caller instead', async () => {
    const onReady = vi.fn();
    const { container } = render(<WebviewHost url='https://example.com/' pristine onWebContentsReady={onReady} />);
    const { view, scripts } = await ready(container);
    expect(scripts.some((script) => script.includes('__webviewHostInjected'))).toBe(false);
    expect(scripts.some((script) => script.includes("addEventListener('submit'"))).toBe(false);
    expect(onReady).toHaveBeenCalledWith(7, view);
    expect(report).not.toHaveBeenCalled();
  });
});
