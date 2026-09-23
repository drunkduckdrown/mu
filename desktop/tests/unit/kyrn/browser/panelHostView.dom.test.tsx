import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { BrowserPanelRequest } from '@/common/kyrn/browserBridge';
import type { BrowserRunEvent } from '@/common/kyrn/browserRun';
import MuBrowserHost from '@/renderer/pages/conversation/Preview/browser/muBrowser/MuBrowserHost';
import { registerWebview } from '@/renderer/pages/conversation/Preview/browser/muBrowser/webviews';
import { onPreviewOpened, type PreviewOpener } from '@/renderer/pages/conversation/Preview/context/previewOpeners';

type Tab = { id: string; content: string; content_type: string; title: string; metadata?: { muRun?: string } };

const wires = vi.hoisted(() => ({
  request: undefined as ((request: unknown) => void) | undefined,
  events: undefined as ((event: unknown) => void) | undefined,
  answer: vi.fn(async () => undefined),
  panel: vi.fn(async () => undefined),
  preview: null as unknown,
}));
vi.mock('@/common/kyrn/browserBridge', () => ({
  kyrnBrowserBridge: {
    request: {
      on: (handler: (request: unknown) => void) => ((wires.request = handler), () => (wires.request = undefined)),
    },
    events: { on: (handler: (event: unknown) => void) => ((wires.events = handler), () => undefined) },
    snapshot: { invoke: async () => [] },
    answer: { invoke: wires.answer },
    panel: { invoke: wires.panel },
    confirm: { invoke: vi.fn() },
    control: { invoke: vi.fn() },
  },
}));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => wires.preview,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function panel(tabs: Tab[], activeTabId: string | null = null, isOpen = true) {
  const value = {
    tabs,
    activeTabId,
    isOpen,
    openPreview: vi.fn(),
    updateTab: vi.fn(),
    switchTab: vi.fn(),
    showPreview: vi.fn(),
  };
  wires.preview = value;
  return value;
}
const ask = (request: BrowserPanelRequest) => act(async () => wires.request?.(request));
const tell = (event: BrowserRunEvent) => act(async () => wires.events?.(event));

/** What the work panel hears: who put something in the preview. */
let heard: PreviewOpener[] = [];
let stopHearing = () => {};
beforeEach(() => {
  heard = [];
  stopHearing = onPreviewOpened((by) => heard.push(by));
});

afterEach(() => {
  stopHearing();
  cleanup();
  vi.clearAllMocks();
  wires.preview = null;
});

describe('the browser panel, as it answers the main process', () => {
  it('says when a panel can be shown, and when no longer', () => {
    panel([]);
    const view = render(<MuBrowserHost conversationId='c1' />);
    expect(wires.panel).toHaveBeenLastCalledWith({ available: true });
    view.unmount();
    expect(wires.panel).toHaveBeenLastCalledWith({ available: false });
  });

  it('offers nothing without a conversation or without a preview provider', () => {
    panel([]);
    render(<MuBrowserHost />);
    wires.preview = null;
    render(<MuBrowserHost conversationId='c1' />);
    expect(wires.panel).not.toHaveBeenCalled();
  });

  it('opens a new tab and answers once the panel has made it', async () => {
    const first = panel([]);
    const view = render(<MuBrowserHost conversationId='c1' />);
    await ask({ kind: 'open', requestId: 'r1', url: 'about:blank' });
    // The agent's open: the work panel marks its preview and stays as it is.
    expect(first.openPreview).toHaveBeenCalledWith('about:blank', 'browser', { muRun: 'r1' }, { by: 'agent' });
    expect(wires.answer).not.toHaveBeenCalled();

    panel([
      { id: 'browser-9', content: 'about:blank', content_type: 'browser', title: 'New Tab', metadata: { muRun: 'r1' } },
    ]);
    view.rerender(<MuBrowserHost conversationId='c1' />);
    await waitFor(() =>
      expect(wires.answer).toHaveBeenCalledWith({
        kind: 'open',
        requestId: 'r1',
        tabId: 'browser-9',
        conversationId: 'c1',
      })
    );
  });

  it('hands out the conversation’s finished mu tab again instead of piling up tabs', async () => {
    const current = panel([
      {
        id: 'browser-9',
        content: 'https://a.test/done',
        content_type: 'browser',
        title: 'A',
        metadata: { muRun: 'r1' },
      },
    ]);
    render(<MuBrowserHost conversationId='c1' />);
    await tell({ type: 'started', tabId: 'browser-9', conversationId: 'c1', url: 'about:blank', at: 1 });
    await tell({ type: 'finished', tabId: 'browser-9', status: 'done', at: 2 });

    await ask({ kind: 'open', requestId: 'r2', url: 'about:blank' });
    expect(current.openPreview).not.toHaveBeenCalled();
    // Blanking the page is the main process's job alone: a second navigation from here could undo mu's first.
    expect(current.updateTab).not.toHaveBeenCalled();
    expect(current.switchTab).toHaveBeenCalledWith('browser-9');
    expect(heard).toEqual(['agent']);
    expect(wires.answer).toHaveBeenCalledWith({
      kind: 'open',
      requestId: 'r2',
      tabId: 'browser-9',
      conversationId: 'c1',
    });
    await tell({ type: 'closed', tabId: 'browser-9' });
  });

  it('refuses when the panel is full, in words the model can act on', async () => {
    const full = panel(
      Array.from({ length: 10 }, (_unused, index) => ({
        id: `b${index}`,
        content: '',
        content_type: 'browser',
        title: '',
      }))
    );
    render(<MuBrowserHost conversationId='c1' />);
    await ask({ kind: 'open', requestId: 'r3', url: 'about:blank' });
    expect(full.openPreview).not.toHaveBeenCalled();
    expect(wires.answer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'open', requestId: 'r3', error: expect.stringContaining('full') })
    );
  });

  it('brings a tab back before giving it the keyboard, and says honestly whether it holds it', async () => {
    const view = document.createElement('div') as unknown as Electron.WebviewTag;
    (view as unknown as HTMLElement).tabIndex = 0;
    document.body.append(view as unknown as HTMLElement);
    registerWebview('browser-9', view);
    const current = panel(
      [{ id: 'browser-9', content: '', content_type: 'browser', title: '', metadata: { muRun: 'r1' } }],
      'file-1',
      false
    );
    render(<MuBrowserHost conversationId='c1' />);

    await ask({ kind: 'keyboard', requestId: 'k1', tabId: 'browser-9' });
    await waitFor(() => expect(wires.answer).toHaveBeenCalledWith({ kind: 'keyboard', requestId: 'k1', held: true }));
    expect(current.switchTab).toHaveBeenCalledWith('browser-9');
    // mu types where the person can see it: a hidden preview is shown, and the work panel comes up on it.
    expect(current.showPreview).toHaveBeenCalled();
    expect(heard).toEqual(['agent-watched']);
    expect(document.activeElement).toBe(view);

    await ask({ kind: 'keyboard', requestId: 'k2', tabId: 'no-such-tab' });
    await waitFor(() => expect(wires.answer).toHaveBeenCalledWith({ kind: 'keyboard', requestId: 'k2', held: false }));
    (view as unknown as HTMLElement).remove();
  });

  it('types into a page already in view without moving anything', async () => {
    const view = document.createElement('div') as unknown as Electron.WebviewTag;
    (view as unknown as HTMLElement).tabIndex = 0;
    document.body.append(view as unknown as HTMLElement);
    registerWebview('browser-9', view);
    const current = panel(
      [{ id: 'browser-9', content: '', content_type: 'browser', title: '', metadata: { muRun: 'r1' } }],
      'browser-9'
    );
    render(<MuBrowserHost conversationId='c1' />);

    await ask({ kind: 'keyboard', requestId: 'k1', tabId: 'browser-9' });
    await waitFor(() => expect(wires.answer).toHaveBeenCalledWith({ kind: 'keyboard', requestId: 'k1', held: true }));
    expect(current.switchTab).not.toHaveBeenCalled();
    expect(current.showPreview).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
    (view as unknown as HTMLElement).remove();
  });

  it('brings the tab forward and shows the question when mu asks for a confirmation', async () => {
    const current = panel([
      { id: 'browser-9', content: '', content_type: 'browser', title: '', metadata: { muRun: 'r1' } },
    ]);
    const view = render(<MuBrowserHost conversationId='c1' />);
    await ask({ kind: 'attention', tabId: 'browser-9', waiting: true });
    expect(current.switchTab).toHaveBeenCalledWith('browser-9');
    expect(heard).toEqual(['agent-watched']);

    await tell({ type: 'started', tabId: 'browser-9', conversationId: 'c1', url: 'about:blank', at: 1 });
    await tell({
      type: 'confirm',
      tabId: 'browser-9',
      confirm: { id: 'q1', label: 'Pay now', url: 'https://shop.test/pay', askedAt: 1, deadline: Date.now() + 60_000 },
    });
    expect(view.baseElement.textContent).toContain('Pay now');
    await tell({ type: 'confirmed', tabId: 'browser-9', id: 'q1', allowed: false });
    await waitFor(() => expect(view.baseElement.textContent).not.toContain('Pay now'));
    await tell({ type: 'closed', tabId: 'browser-9' });
  });
});
