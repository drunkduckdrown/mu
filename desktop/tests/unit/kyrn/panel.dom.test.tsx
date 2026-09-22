import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import type { Activity, ActivityPage, Result } from '@/common/kyrn/types';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';
import KyrnPanel, { onHiveFocus, requestHiveFocus } from '@/renderer/pages/conversation/KyrnPanel';

const { activity } = vi.hoisted(() => ({ activity: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { activity: { invoke: activity } },
  unwrap: (result: Result<ActivityPage>) => {
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
}));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common, mu } } },
    interpolation: { escapeValue: false },
  });
});
beforeEach(() =>
  activity.mockResolvedValue({ ok: true, data: { sessionId: 'session', cursor: 0, more: false, events: [] } })
);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>{children}</MemoryRouter>
    </I18nextProvider>
  );
}

const snapshots: Activity[] = ['run-1', 'run-2'].map((run) => ({
  id: run,
  at: 1,
  kind: 'swarm.snapshot',
  run,
  payload: { title: run, bees: [{ name: 'reviewer', status: 'thinking', said: `${run} findings` }] },
}));

describe('KYRN panel entry and Hive navigation', () => {
  it('exports the navigation API used by Layout and removes listeners on unmount', () => {
    // Import the real panel entry: a mocked panel hid the missing-export startup crash.
    const listener = vi.fn();
    const stop = onHiveFocus(listener);
    try {
      requestHiveFocus({ conversationId: 'conv', runId: 'run-2', beeName: 'reviewer' });
      expect(listener).toHaveBeenCalledWith({ conversationId: 'conv', runId: 'run-2', beeName: 'reviewer' });
    } finally {
      stop();
    }
    requestHiveFocus({ conversationId: 'conv', runId: 'run-1' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed navigation events', () => {
    const listener = vi.fn();
    const stop = onHiveFocus(listener);
    try {
      for (const detail of [null, {}, { conversationId: 'conv', runId: 3 }]) {
        window.dispatchEvent(new CustomEvent('kyrn:hive-focus', { detail }));
      }
      expect(listener).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('opens only the requested run and bee after activity arrives', async () => {
    let resolve!: (value: Result<ActivityPage>) => void;
    activity.mockReturnValueOnce(
      new Promise<Result<ActivityPage>>((done) => {
        resolve = done;
      })
    );
    const { container, rerender } = render(<KyrnPanel conversationId='conv' />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: common.kyrn.memory }));
    rerender(
      <KyrnPanel conversationId='conv' focus={{ conversationId: 'conv', runId: 'run-2', beeName: 'reviewer' }} />
    );
    resolve({ ok: true, data: { sessionId: 'session', cursor: 1, more: false, events: snapshots } });

    expect(await screen.findByText('run-2 findings')).toBeVisible();
    const run = container.querySelector('[data-hive-run="run-1"]')!;
    expect(within(run as HTMLElement).queryByText('run-1 findings')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: common.kyrn.hive })).toHaveAttribute('aria-selected', 'true');
  });

  it('does not change the selected tab for another conversation', async () => {
    const { rerender } = render(<KyrnPanel conversationId='conv' />, { wrapper: Wrapper });
    await waitFor(() => expect(activity).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: common.kyrn.memory }));
    rerender(<KyrnPanel conversationId='conv' focus={{ conversationId: 'other', runId: 'run-2' }} />);
    expect(screen.getByRole('tab', { name: common.kyrn.memory })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the panel visible when activity loading fails', async () => {
    activity.mockRejectedValueOnce(new Error('fixture offline'));
    render(<KyrnPanel conversationId='conv' />, { wrapper: Wrapper });
    // A translated headline leads; the bridge's own message follows as a detail, without the "Error:" prefix.
    expect(await screen.findByText(common.kyrn.activityLoadFailed)).toBeVisible();
    expect(screen.getByText('fixture offline')).toBeVisible();
    expect(screen.queryByText('Error: fixture offline')).not.toBeInTheDocument();
    expect(screen.getByTestId('kyrn-context')).toBeInTheDocument();
  });

  it('words a bee in the app language: plural counts, thinking level, silence and error', async () => {
    const bee = {
      name: 'reviewer',
      status: 'failed',
      model: 'gpt-5',
      thinking: 'xhigh',
      turns: 1,
      toolCalls: 2,
      published: 0,
      received: 1,
      quietMs: 312_000,
      error: 'ENOENT: no such file',
    };
    activity.mockResolvedValue({
      ok: true,
      data: {
        sessionId: 'session',
        cursor: 1,
        more: false,
        events: [
          { id: 'run-1', at: 1, kind: 'swarm.snapshot', run: 'run-1', payload: { title: 'run-1', bees: [bee] } },
        ],
      },
    });
    render(
      <KyrnPanel conversationId='conv' focus={{ conversationId: 'conv', runId: 'run-1', beeName: 'reviewer' }} />,
      {
        wrapper: Wrapper,
      }
    );

    expect(await screen.findByText('1 turn · 2 tool calls · 0 shared · 1 received')).toBeVisible();
    expect(screen.getByText('gpt-5 · Very high')).toBeVisible();
    expect(screen.getByText('No activity for 5 min, 12 sec')).toBeVisible();
    expect(screen.getByText(common.kyrn.beeFailed)).toBeVisible();
    expect(screen.getByText('ENOENT: no such file')).toBeVisible();
  });

  it('names judgments by their question and runtime events by their kind, never by raw ids', async () => {
    activity.mockResolvedValue({
      ok: true,
      data: {
        sessionId: 'session',
        cursor: 3,
        more: false,
        events: [
          { id: 'recall', at: 1, kind: 'decision', payload: { specId: 'memory.recall', outcome: { apply: [] } } },
          { id: 'odd', at: 2, kind: 'decision', payload: { specId: 'memory.future', outcome: 'x' } },
          { id: 'board', at: 3, kind: 'board.switched', payload: { on: false, score: 0.5 } },
        ],
      },
    });
    render(<KyrnPanel conversationId='conv' />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: common.kyrn.memory }));

    expect(await screen.findByText(common.kyrn.judgeView.questions.recall)).toBeVisible();
    expect(screen.getByText(common.kyrn.judgeView.questions.other)).toBeVisible();
    expect(screen.queryByText(/memory\.recall/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: common.kyrn.decisions }));
    expect(await screen.findByText(common.kyrn.event.board.switched)).toBeVisible();
    expect(screen.getByText('0.50')).toBeVisible();
  });
});
