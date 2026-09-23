import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import type { Activity, ActivityPage, Result } from '@/common/kyrn/types';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import { KernelBody, useKyrnActivity } from '@/renderer/pages/conversation/KyrnPanel';
import Board from '@/renderer/pages/conversation/KyrnPanel/Board';
import { boardHistory, boardView, toBoardUpdate } from '@/renderer/pages/conversation/KyrnPanel/Board/board';
import { emitter, type SendBoxCommandState } from '@/renderer/utils/emitter';

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
  // German with the English texts: what changes is only how numbers are written.
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common } }, 'de-DE': { translation: { common } } },
    interpolation: { escapeValue: false },
  });
});
const page = (events: Activity[]) => ({
  ok: true,
  data: { sessionId: 'session', cursor: events.length, more: false, events },
});
beforeEach(() => activity.mockResolvedValue(page([])));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  emitter.removeAllListeners();
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>{children}</MemoryRouter>
    </I18nextProvider>
  );
}

let next = 0;
const event = (kind: string, payload: Record<string, unknown>): Activity => ({
  id: `e${++next}`,
  at: next,
  kind,
  payload,
});
const switched = (on: boolean) => event('board.switched', { on, cwd: '/work/app' });
const update = (payload: Record<string, unknown> = {}) =>
  event('board.update', {
    progress: 'The login page works; the tests for it are half written.',
    now: 'Writing the tests for the login page',
    confirm: [],
    phase: 'checking',
    needsUser: false,
    done: 3,
    total: 5,
    by: 'model',
    ended: false,
    ...payload,
  });

const showBoard = (events: Activity[]) => render(<Board events={events} conversationId='conv' />, { wrapper: Wrapper });

describe('reading the board from the session’s events', () => {
  it('follows the last switch and the last board, in the order they came', () => {
    expect(boardView([])).toEqual({ known: false, on: undefined });
    const first = update();
    const last = update({ now: 'Wrapping up', restored: true });
    const view = boardView([switched(true), first, switched(false), switched(true), last]);
    expect(view.on).toBe(true);
    expect(view.update).toMatchObject({ id: last.id, now: 'Wrapping up', restored: true });
    expect(boardView([switched(true), first, switched(false)]).on).toBe(false);
    // A board from a harness whose switch was not seen means the board is on.
    expect(boardView([first]).on).toBe(true);
  });

  it('keeps only what it can show: known stages, text lines, counts that add up', () => {
    expect(
      toBoardUpdate(
        update({ phase: 'celebrating', confirm: ['  Keep the old API?  ', 7, ''], done: 9, total: 4, by: 'x' })
      )
    ).toMatchObject({ confirm: ['Keep the old API?'], done: 4, total: 4, by: 'model', needsUser: false });
    expect(toBoardUpdate(update({ phase: 'celebrating' }))?.phase).toBeUndefined();
    expect(toBoardUpdate(update({ now: '', progress: '' }))).toBeUndefined();
    expect(toBoardUpdate(update({ now: 'x'.repeat(2000) }))?.now).toHaveLength(601);
  });
});

describe('the board panel', () => {
  it('when off, says what it does and what it costs, and turns on with the harness’s own command', () => {
    const sent = vi.fn();
    emitter.on('sendbox.command', sent);
    showBoard([switched(false)]);
    const off = screen.getByTestId('mu-board-off');
    expect(off).toHaveTextContent('Each update costs one model call');
    // The switch is the one control: no second button for the same thing.
    expect(within(off).queryByRole('button')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-board-switch'));
    expect(sent).toHaveBeenCalledWith('/board on', 'conv', expect.any(Function));
    expect(screen.getByTestId('mu-board-switch')).toBeDisabled();
    expect(screen.getByText('Switching…')).toBeInTheDocument();
  });

  it('offers nothing where the harness never said it has a board: another agent, or the feature off', () => {
    const sent = vi.fn();
    emitter.on('sendbox.command', sent);
    showBoard([]);
    expect(screen.getByTestId('mu-board-unknown')).toHaveTextContent('under Features');
    expect(screen.queryByTestId('mu-board-off')).not.toBeInTheDocument();
    expect(screen.getByTestId('mu-board-switch')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mu-board-switch'));
    expect(sent).not.toHaveBeenCalled();
  });

  it('while the agent works, says the switch waits for the step to end, and frees it when dropped', () => {
    let heard: ((state: SendBoxCommandState) => void) | undefined;
    emitter.on('sendbox.command', (_command: string, _target: string, reply?: (state: SendBoxCommandState) => void) => {
      heard = reply;
    });
    showBoard([switched(true), update()]);
    fireEvent.click(screen.getByTestId('mu-board-switch'));
    act(() => heard?.('waiting'));
    expect(screen.getByTestId('mu-board-pending')).toHaveTextContent('Switches when the agent finishes this step');
    expect(screen.getByTestId('mu-board-switch')).toBeDisabled();
    act(() => heard?.('dropped'));
    expect(screen.queryByTestId('mu-board-pending')).not.toBeInTheDocument();
    expect(screen.getByTestId('mu-board-switch')).not.toBeDisabled();
  });

  it('when on with nothing yet, says so plainly, with no spinner', () => {
    showBoard([switched(true)]);
    expect(screen.getByTestId('mu-board-empty')).toHaveTextContent('Give the agent a moment');
    expect(document.querySelector('.arco-spin')).toBeNull();
  });

  it('shows the stage, what is done now, how far it is, and what needs the person', () => {
    const quoted = vi.fn();
    emitter.on('sendbox.reply', quoted);
    showBoard([
      switched(true),
      update({ needsUser: true, confirm: ['Keep the old login URL working?', 'Drop Internet Explorer support?'] }),
    ]);
    expect(screen.getByTestId('mu-board-phase')).toHaveTextContent('Checking the work');
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('Writing the tests for the login page');
    expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('half written');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    expect(screen.getByText('3 of 5 checks done')).toBeInTheDocument();

    const ask = screen.getByTestId('mu-board-ask');
    expect(ask).toHaveTextContent('Needs you');
    fireEvent.click(within(ask).getByText('Drop Internet Explorer support?'));
    // Quoted into the reply, never sent.
    expect(quoted).toHaveBeenCalledWith(expect.objectContaining({ content: 'Drop Internet Explorer support?' }));
  });

  it('counts a single acceptance item in the singular', () => {
    showBoard([switched(true), update({ done: 0, total: 1 })]);
    expect(screen.getByText('0 of 1 check done')).toBeInTheDocument();
  });

  it('writes the counts in the app language', async () => {
    await i18n.changeLanguage('de-DE');
    try {
      showBoard([switched(true), update({ done: 1000, total: 1234 })]);
      expect(screen.getByText('1.000 of 1.234 checks done')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', '1.000 of 1.234 checks done');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('marks a board written by rules, one written as the agent stopped, and a stuck agent', () => {
    showBoard([switched(true), update({ by: 'rules', ended: true, phase: 'stuck', total: 0, done: 0 })]);
    expect(screen.getByText('Brief')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByTestId('mu-board-phase')).toHaveTextContent('Seems stuck');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mu-board-ask')).not.toBeInTheDocument();
  });

  it('reads out and fades in a board that comes while it is open, through a live region that stays in place', () => {
    const events = [switched(true)];
    const { rerender } = showBoard(events);
    const live = screen.getByTestId('mu-board-announce');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toBeEmptyDOMElement();

    const first = update();
    rerender(<Board events={[...events, first]} conversationId='conv' />);
    expect(screen.getByTestId('mu-board-announce')).toBe(live);
    // One paragraph per part, no English full stop glued between them: the model's lines bring their own.
    const parts = () => [...live.querySelectorAll('p')].map((part) => part.textContent);
    expect(parts()).toEqual([
      'Checking the work',
      'Writing the tests for the login page',
      'The login page works; the tests for it are half written.',
    ]);
    expect(document.querySelector('[data-fresh="true"]')).not.toBeNull();

    rerender(
      <Board events={[...events, first, update({ now: 'Wrapping up', phase: 'wrapping_up' })]} conversationId='conv' />
    );
    expect(screen.getByTestId('mu-board-announce')).toBe(live);
    expect(parts()).toEqual(['Wrapping up', 'Wrapping up', 'The login page works; the tests for it are half written.']);
  });

  it('neither reads out nor fades in the board already there, or the one replayed as the session opens', () => {
    const { unmount } = showBoard([switched(true), update()]);
    expect(screen.getByTestId('mu-board-announce')).toBeEmptyDOMElement();
    expect(document.querySelector('[data-fresh="true"]')).toBeNull();
    unmount();

    const events = [switched(true)];
    const { rerender } = showBoard(events);
    rerender(<Board events={[...events, update({ restored: true })]} conversationId='conv' />);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('Writing the tests');
    expect(screen.getByTestId('mu-board-announce')).toBeEmptyDOMElement();
    expect(document.querySelector('[data-fresh="true"]')).toBeNull();
  });

  it('turns off from its switch, with the harness’s own command', () => {
    const sent = vi.fn();
    emitter.on('sendbox.command', sent);
    showBoard([switched(true), update()]);
    fireEvent.click(screen.getByTestId('mu-board-switch'));
    expect(sent).toHaveBeenCalledWith('/board off', 'conv', expect.any(Function));
  });
});

describe('what the board said before', () => {
  it('keeps the earlier boards, newest first, without the replayed, the repeated or the current one', () => {
    const reading = update({ now: 'Reading the code', progress: 'Nothing is done yet.' });
    const again = update({ now: 'Reading the code', progress: 'Nothing is done yet.' });
    const fixing = update({ now: 'Fixing the login test', progress: 'Half the tests pass.' });
    const replayed = update({ now: 'Fixing the login test', progress: 'Half the tests pass.', restored: true });
    const current = update();
    const earlier = boardHistory([switched(true), reading, again, fixing, replayed, current], toBoardUpdate(current));
    expect(earlier.map((entry) => entry.update.id)).toEqual([fixing.id, reading.id]);
    expect(earlier[0].at).toBe(fixing.at);
    // Saying the same as the current board is no history.
    const same = update();
    expect(boardHistory([same, current], toBoardUpdate(current))).toEqual([]);
  });

  it('lists them under the current board as quiet lines, while the board is on', () => {
    showBoard([
      switched(true),
      update({ now: 'Reading the code', progress: 'Nothing is done yet.' }),
      update({ now: 'Fixing the login test', progress: '' }),
      update(),
    ]);
    const earlier = screen.getByTestId('mu-board-earlier');
    expect(earlier).toHaveTextContent('Earlier');
    const rows = within(earlier).getAllByRole('listitem');
    // What was done, or else what it was doing.
    expect(rows[0]).toHaveTextContent('Fixing the login test');
    expect(rows[1]).toHaveTextContent('Nothing is done yet.');
    cleanup();

    showBoard([switched(true), update(), switched(false)]);
    expect(screen.queryByTestId('mu-board-earlier')).not.toBeInTheDocument();
  });
});

/** The work panel's board tab for one conversation. */
function BoardTab() {
  const read = useKyrnActivity('conv');
  return <KernelBody tab='board' conversationId='conv' activity={read} />;
}

describe('the board in the work panel', () => {
  it('waits for the conversation’s record, then shows its board', async () => {
    activity.mockResolvedValue(page([switched(true), update()]));
    render(<BoardTab />, { wrapper: Wrapper });
    expect(screen.getByText(common.loading)).toBeInTheDocument();
    expect(await screen.findByTestId('mu-board-now')).toHaveTextContent('Writing the tests');
    expect(activity).toHaveBeenCalledWith({ conversationId: 'conv', cursor: 0, sessionId: '' });
    // The board already there when the tab opened is not news: nothing is read out.
    expect(screen.getByTestId('mu-board-announce')).toBeEmptyDOMElement();
  });

  it('offers to turn the board on when it is off for the project', async () => {
    activity.mockResolvedValue(page([switched(false)]));
    render(<BoardTab />, { wrapper: Wrapper });
    expect(await screen.findByTestId('mu-board-off')).toBeVisible();
    expect(screen.getByTestId('mu-board-switch')).not.toBeDisabled();
    await act(async () => undefined);
  });
});
