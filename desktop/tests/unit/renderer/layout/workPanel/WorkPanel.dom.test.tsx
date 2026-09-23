/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import type { Activity } from '@/common/kyrn/types';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';

type StreamMessage = { type: string; data: unknown; conversation_id?: string };

const wires = vi.hoisted(() => ({
  /** Each conversation's kernel record, as the bridge hands it out page by page. */
  records: {} as Record<string, unknown[]>,
  /** Each conversation's lessons, as the main process folds them from mu's file; and which conversations read them. */
  lessons: {} as Record<string, unknown>,
  lessonReads: [] as string[],
  stream: undefined as undefined | ((message: StreamMessage) => void),
  preview: {
    isOpen: false,
    activeTab: null as null | { id: string },
    tabs: [] as { id: string }[],
    isMaximized: false,
    showPreview: () => {},
  },
}));

vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: {
    activity: {
      invoke: async ({ conversationId, cursor }: { conversationId: string; cursor: number }) => {
        const all = wires.records[conversationId] ?? [];
        return {
          ok: true,
          data: { sessionId: 'session', cursor: all.length, more: false, events: all.slice(cursor) },
        };
      },
    },
    lessons: {
      invoke: async ({ conversationId }: { conversationId: string }) => {
        wires.lessonReads.push(conversationId);
        return { ok: true, data: wires.lessons[conversationId] ?? { project: '', lessons: [] } };
      },
    },
  },
  unwrap: (result: { data: unknown }) => result.data,
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: (listener: (message: StreamMessage) => void) => {
          wires.stream = listener;
          return () => {
            wires.stream = undefined;
          };
        },
      },
    },
  },
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => wires.preview,
  PreviewPanel: () => <div data-testid='preview-panel' />,
}));
vi.mock('@/renderer/pages/conversation/explorer/ExplorerContainer', () => ({
  ExplorerContainer: ({
    view,
    onViewChange,
  }: {
    view?: string;
    onViewChange?: (view: 'files' | 'changes') => void;
  }) => (
    <div data-testid='explorer' data-view={view}>
      <button type='button' onClick={() => onViewChange?.('files')}>
        reveal in files
      </button>
    </div>
  ),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useVisibleConversationIds', () => ({
  useVisibleConversationIds: () => [],
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true, isMacOS: () => true }));

import WorkPanelHost, { panelGeometry } from '@/renderer/components/layout/WorkPanel';
import { readWorkPanelMemory, resetWorkPanelStoreForTest } from '@/renderer/components/layout/WorkPanel/workPanelStore';
import { useConversationShortcuts } from '@/renderer/hooks/ui/useConversationShortcuts';
import {
  resetCurrentConversationForTest,
  setCurrentConversation,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';
import {
  resetCurrentProjectForTest,
  setCurrentProject,
} from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { requestHiveFocus } from '@/renderer/pages/conversation/KyrnPanel';
import { announcePreviewOpened } from '@/renderer/pages/conversation/Preview/context/previewOpeners';
import {
  dispatchWorkspaceToggleEvent,
  WORKSPACE_STATE_EVENT,
  type WorkspaceStateDetail,
} from '@/renderer/utils/workspace/workspaceEvents';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common, mu } } },
    interpolation: { escapeValue: false },
  });
});

let next = 0;
const event = (kind: string, payload: Record<string, unknown>, extra: Partial<Activity> = {}): Activity => ({
  id: `e${++next}`,
  at: 1_000 + next,
  kind,
  payload,
  ...extra,
});
const board = (now: string) =>
  event('board.update', {
    progress: 'Half the tests pass.',
    now,
    confirm: [],
    phase: 'fixing',
    needsUser: false,
    done: 1,
    total: 2,
    by: 'model',
    ended: false,
  });

/** The conversation page as far as the panel is concerned: the common shortcuts and the panel beside the chat. */
function Page({ isMobile = false }: { isMobile?: boolean }) {
  useConversationShortcuts({ navigate: vi.fn() as unknown as NavigateFunction, toggleSider: () => {} });
  return <WorkPanelHost rowWidth={1400} isMobile={isMobile} />;
}
/** The row the panel shares with the page, holding a composer zone the panel measures. */
const Row = ({ rowWidth }: { rowWidth: number }) => (
  <div data-testid='row'>
    <div data-composer-zone='' />
    <WorkPanelHost rowWidth={rowWidth} isMobile={false} />
  </div>
);
const show = (props: { isMobile?: boolean } = {}) =>
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <Page {...props} />
      </MemoryRouter>
    </I18nextProvider>
  );

/** Let the kernel record's next read land. */
const poll = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
/** One animation frame. */
const frame = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });

const panel = () => screen.getByTestId('work-panel');
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
const selected = () => screen.getByRole('tab', { selected: true });
const dots = () =>
  screen.queryAllByTestId('work-panel-dot').map((dot) => dot.closest('[role="tab"]')?.getAttribute('data-tab'));
const shortcut = (key: string) => {
  const keydown = new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(keydown);
  });
  return keydown;
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetWorkPanelStoreForTest();
  resetCurrentConversationForTest();
  resetCurrentProjectForTest();
  wires.records = {};
  wires.lessons = {};
  wires.lessonReads = [];
  wires.preview = { isOpen: false, activeTab: null, tabs: [], isMaximized: false, showPreview: () => {} };
  setCurrentConversation('conv-1');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the work panel', () => {
  it('shows its tabs in one strip, in order: board, judge, hive, lessons, files, preview, source', async () => {
    show();
    await settle();
    expect(screen.getAllByRole('tab').map((item) => item.textContent)).toEqual([
      'Board',
      'Judge',
      'Hive',
      'Lessons',
      'Files',
      'Preview',
      'Source',
    ]);
    expect(screen.getByRole('tablist')).toHaveAccessibleName(common.workPanel.tabsLabel);
  });

  it('is closed until asked, and then out of the way: no width, nothing to reach inside', async () => {
    show();
    await settle();
    expect(panel()).toHaveAttribute('data-open', 'false');
    expect(panel()).toHaveAttribute('inert');
    expect(panel().style.width).toBe('0px');
  });

  it('opens and closes from the titlebar’s toggle and from Cmd+J, and tells the titlebar each time', async () => {
    const states: boolean[] = [];
    const hear = (heard: Event) => states.push((heard as CustomEvent<WorkspaceStateDetail>).detail.collapsed);
    window.addEventListener(WORKSPACE_STATE_EVENT, hear);
    try {
      show();
      await settle();
      let handled = false;
      act(() => {
        handled = dispatchWorkspaceToggleEvent();
      });
      expect(handled).toBe(true);
      expect(panel()).toHaveAttribute('data-open', 'true');
      expect(panel()).not.toHaveAttribute('inert');
      expect(panel().style.width).toBe('360px');

      const chord = shortcut('j');
      expect(chord.defaultPrevented).toBe(true);
      expect(panel()).toHaveAttribute('data-open', 'false');
      shortcut('j');
      expect(panel()).toHaveAttribute('data-open', 'true');
      // The close button in the strip.
      fireEvent.click(screen.getByRole('button', { name: common.workPanel.close }));
      expect(panel()).toHaveAttribute('data-open', 'false');
      expect(states).toEqual([true, false, true, false, true]);
    } finally {
      window.removeEventListener(WORKSPACE_STATE_EVENT, hear);
    }
  });

  it('remembers, per conversation, whether it is open, on which tab and how wide', async () => {
    show();
    await settle();
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Judge'));
    fireEvent.keyDown(screen.getByTestId('work-panel-resize'), { key: 'ArrowLeft' });
    expect(panel().style.width).toBe('376px');

    // A conversation it was never used in starts from that choice; closing it there changes only that one.
    act(() => setCurrentConversation('conv-2'));
    await settle();
    expect(panel()).toHaveAttribute('data-open', 'true');
    expect(selected()).toHaveTextContent('Judge');
    fireEvent.click(tab('Hive'));
    fireEvent.click(screen.getByRole('button', { name: common.workPanel.close }));

    act(() => setCurrentConversation('conv-1'));
    await settle();
    expect(panel()).toHaveAttribute('data-open', 'true');
    expect(selected()).toHaveTextContent('Judge');
    expect(panel().style.width).toBe('376px');

    act(() => setCurrentConversation('conv-2'));
    await settle();
    expect(panel()).toHaveAttribute('data-open', 'false');
    expect(selected()).toHaveTextContent('Hive');

    // And after a restart.
    resetWorkPanelStoreForTest();
    expect(readWorkPanelMemory('conv-1')).toEqual({ open: true, tab: 'judge', width: 376 });
    expect(readWorkPanelMemory('conv-2')).toEqual({ open: false, tab: 'hive', width: 376 });
  });

  it('puts a dot on a tab with a new board update until it is looked at', async () => {
    wires.records['conv-1'] = [board('Reading the code')];
    show();
    await settle();
    // The board already there is where the conversation stands, not news.
    expect(dots()).toEqual([]);

    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Judge'));
    wires.records['conv-1'] = [...wires.records['conv-1'], board('Running the tests')];
    await poll();
    expect(dots()).toEqual(['board']);
    expect(tab('Board')).toHaveAccessibleName(`Board, new`);

    fireEvent.click(tab('Board'));
    expect(dots()).toEqual([]);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('Running the tests');
    fireEvent.click(tab('Judge'));
    expect(dots()).toEqual([]);
  });

  it('never opens itself for news: a board update while it is closed waits behind its dot', async () => {
    wires.records['conv-1'] = [board('Reading the code')];
    show();
    await settle();
    // Last left on the judge tab.
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Judge'));
    fireEvent.click(screen.getByRole('button', { name: common.workPanel.close }));

    wires.records['conv-1'] = [...wires.records['conv-1'], board('Running the tests')];
    await poll();
    expect(panel()).toHaveAttribute('data-open', 'false');
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    expect(selected()).toHaveTextContent('Judge');
    expect(dots()).toEqual(['board']);
  });

  it('puts a dot on the lessons tab for a lesson event, and reads the lessons only once they are shown', async () => {
    const lesson = {
      id: 'lesson-1',
      kind: 'pitfall',
      trigger: 'Running the desktop tests',
      lesson: 'Run vitest with Node 24.',
      scope: { cwd: '/work/app' },
      source: { origin: 'outcome' },
      status: 'active',
      uses: { recalled: 1, applied: 0 },
      created: '2026-09-23T00:00:00.000Z',
      updated: '2026-09-23T00:00:00.000Z',
    };
    wires.records['conv-1'] = [event('memory.stored', lesson)];
    wires.lessons['conv-1'] = { project: '/work/app', lessons: [lesson] };
    show();
    await settle();
    // A lesson stored before the conversation was opened is where it stands, not news.
    expect(dots()).toEqual([]);

    wires.records['conv-1'] = [...wires.records['conv-1'], event('memory.recalled', { ids: ['lesson-1'], turn: 2 })];
    await poll();
    expect(dots()).toEqual(['lessons']);
    expect(tab('Lessons')).toHaveAccessibleName('Lessons, new');
    expect(wires.lessonReads).toEqual([]);

    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Lessons'));
    await settle();
    expect(dots()).toEqual([]);
    expect(wires.lessonReads).toEqual(['conv-1']);
    expect(screen.getByTestId('mu-lessons')).toHaveTextContent('Run vitest with Node 24.');
    expect(screen.getByTestId('mu-lessons-notes')).toHaveTextContent('This turn brought in 1 lesson');
  });

  it('marks the files tab for an edit the agent finished, in the conversation it belongs to', async () => {
    show();
    await settle();
    const edit = (conversation: string, id: string) =>
      act(() =>
        wires.stream?.({
          type: 'acp_tool_call',
          conversation_id: conversation,
          data: { update: { tool_call_id: id, kind: 'edit', status: 'completed' } },
        })
      );
    edit('conv-2', 'a');
    expect(dots()).toEqual([]);
    edit('conv-1', 'b');
    expect(dots()).toEqual(['files']);
    act(() => setCurrentConversation('conv-2'));
    await settle();
    expect(dots()).toEqual(['files']);
  });

  it('comes up on its preview when the person opens something, and only marks the preview when the agent does', async () => {
    show();
    await settle();
    act(() => announcePreviewOpened('agent'));
    expect(panel()).toHaveAttribute('data-open', 'false');
    expect(dots()).toEqual(['preview']);

    act(() => announcePreviewOpened('user'));
    expect(panel()).toHaveAttribute('data-open', 'true');
    expect(selected()).toHaveTextContent('Preview');
    expect(dots()).toEqual([]);
    expect(screen.getByText(common.workPanel.previewEmpty)).toBeInTheDocument();

    // mu's browser about to type is done where the person can see it.
    fireEvent.click(tab('Board'));
    act(() => announcePreviewOpened('agent-watched'));
    expect(selected()).toHaveTextContent('Preview');
  });

  it('opens on the hive tab, at the sub-agent clicked in the transcript', async () => {
    wires.records['conv-1'] = [
      event(
        'swarm.snapshot',
        {
          kind: 'hive',
          title: 'Why do the tests flake?',
          bees: [
            { name: 'scout', status: 'thinking', said: 'Reading the retry.' },
            { name: 'critic', status: 'done', said: 'The fix holds.' },
          ],
        },
        { run: 'run-1' }
      ),
    ];
    show();
    await settle();
    // Another conversation's sub-agent changes nothing here.
    act(() => requestHiveFocus({ conversationId: 'conv-2', runId: 'run-1', beeName: 'scout' }));
    expect(panel()).toHaveAttribute('data-open', 'false');

    act(() => requestHiveFocus({ conversationId: 'conv-1', runId: 'run-1', beeName: 'critic' }));
    await settle();
    expect(panel()).toHaveAttribute('data-open', 'true');
    expect(selected()).toHaveTextContent('Hive');
    const critic = screen.getByText('critic').closest('[data-bee]') as HTMLElement;
    expect(within(critic).getByRole('button', { expanded: true })).toBeInTheDocument();
  });

  it('shares one explorer between files and source, each tab choosing its view', async () => {
    setCurrentProject('project-1');
    show();
    await settle();
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Source'));
    expect(screen.getByTestId('explorer')).toHaveAttribute('data-view', 'changes');
    // The explorer asks for its files view itself (a search hit revealed): the files tab comes forward.
    fireEvent.click(screen.getByText('reveal in files'));
    expect(selected()).toHaveTextContent('Files');
    expect(screen.getAllByTestId('explorer')).toHaveLength(1);
  });

  it('says there are no files in a conversation without a project folder', async () => {
    show();
    await settle();
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Files'));
    expect(screen.getByText(common.workPanel.noProject)).toBeInTheDocument();
    expect(screen.queryByTestId('explorer')).not.toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys', async () => {
    show();
    await settle();
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.keyDown(tab('Board'), { key: 'ArrowRight' });
    expect(selected()).toHaveTextContent('Judge');
    expect(document.activeElement).toBe(tab('Judge'));
    fireEvent.keyDown(tab('Judge'), { key: 'End' });
    expect(selected()).toHaveTextContent('Source');
    fireEvent.keyDown(tab('Source'), { key: 'Home' });
    expect(selected()).toHaveTextContent('Board');
  });

  it('is resized by its handle: live while dragging, remembered when the drag ends, within its bounds', async () => {
    show();
    await settle();
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    const handle = screen.getByTestId('work-panel-resize');
    fireEvent.pointerDown(handle, { clientX: 1_000, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 900 });
    await frame();
    expect(panel().style.width).toBe('460px');
    expect(readWorkPanelMemory('conv-1').width).toBe(360);
    fireEvent.pointerUp(window);
    expect(readWorkPanelMemory('conv-1').width).toBe(460);

    // Never wider than 60% of the window (jsdom's is 1024px wide), nor narrower than 270px.
    fireEvent.pointerDown(handle, { clientX: 1_000, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 0 });
    fireEvent.pointerUp(window);
    expect(readWorkPanelMemory('conv-1').width).toBe(614);
    fireEvent.pointerDown(handle, { clientX: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 1_000 });
    fireEvent.pointerUp(window);
    expect(readWorkPanelMemory('conv-1').width).toBe(270);
    // A double click goes back to the default.
    fireEvent.doubleClick(handle);
    expect(readWorkPanelMemory('conv-1').width).toBe(360);
  });

  it('is a sheet over the chat on a phone, closed by its backdrop', async () => {
    show({ isMobile: true });
    await settle();
    expect(panel()).toHaveAttribute('data-mode', 'sheet');
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    expect(screen.queryByTestId('work-panel-resize')).not.toBeInTheDocument();
    const backdrop = document.querySelector('[aria-hidden="true"][class*="backdrop"]') as HTMLElement;
    fireEvent.click(backdrop);
    expect(panel()).toHaveAttribute('data-open', 'false');
  });

  it('shows nothing without a conversation', () => {
    act(() => setCurrentConversation(null));
    show();
    expect(screen.queryByTestId('work-panel')).not.toBeInTheDocument();
  });
});

describe('where the panel sits', () => {
  it('beside the transcript while both fit, over it when the window is narrow, as a sheet on a phone', () => {
    // 60% of the window at most, 360px left to the transcript beside the panel's 1px edge, 270px at least.
    expect(panelGeometry(1400, 1024, false, 360)).toEqual({ mode: 'dock', width: 360, max: 614 });
    expect(panelGeometry(1400, 1024, false, 900)).toEqual({ mode: 'dock', width: 614, max: 614 });
    expect(panelGeometry(900, 1600, false, 600)).toEqual({ mode: 'dock', width: 539, max: 539 });
    // A 900px window with the sidebar open leaves the row 639px: the transcript shrinks, nothing is covered (B4).
    expect(panelGeometry(639, 900, false, 360)).toEqual({ mode: 'dock', width: 278, max: 278 });
    expect(panelGeometry(600, 1024, false, 360)).toEqual({ mode: 'float', width: 360, max: 599 });
    expect(panelGeometry(390, 390, true, 360)).toEqual({ mode: 'sheet', width: 332, max: 332 });
  });

  describe('floating over a narrow transcript', () => {
    /** The page's row as the panel measures it: 800px tall, the composer zone's top at `zoneTop`. */
    let zoneTop = 650;
    beforeEach(() => {
      zoneTop = 650;
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const id = this.getAttribute('data-testid');
        if (id === 'row') return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 800 });
        if (this.hasAttribute('data-composer-zone'))
          return DOMRect.fromRect({ x: 0, y: zoneTop, width: 560, height: 800 - 16 - zoneTop });
        return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const showRow = (rowWidth: number) =>
      render(
        <I18nextProvider i18n={i18n}>
          <MemoryRouter>
            <Row rowWidth={rowWidth} />
          </MemoryRouter>
        </I18nextProvider>
      );

    it('stops above the composer, with an edge of its own, and follows the composer growing', async () => {
      showRow(600);
      await settle();
      act(() => {
        dispatchWorkspaceToggleEvent();
      });
      await frame();
      expect(panel()).toHaveAttribute('data-mode', 'float');
      // From the composer zone's top (650) to the row's bottom (800), and an 8px gap.
      expect(panel()).toHaveAttribute('data-lifted', 'true');
      expect(panel().style.bottom).toBe('158px');

      // The composer grows (a second line, the working line): the panel moves up with it.
      zoneTop = 600;
      act(() => {
        screen.getByTestId('row').querySelector('[data-composer-zone]')?.append(document.createElement('span'));
      });
      await frame();
      expect(panel().style.bottom).toBe('208px');
    });

    it('sits on the whole height while closed or docked', async () => {
      showRow(600);
      await settle();
      expect(panel()).toHaveAttribute('data-open', 'false');
      expect(panel()).not.toHaveAttribute('data-lifted');
      expect(panel().style.bottom).toBe('');
      cleanup();

      showRow(1400);
      await settle();
      act(() => {
        dispatchWorkspaceToggleEvent();
      });
      await frame();
      expect(panel()).toHaveAttribute('data-mode', 'dock');
      expect(panel()).not.toHaveAttribute('data-lifted');
      expect(panel().style.bottom).toBe('');
    });
  });
});
