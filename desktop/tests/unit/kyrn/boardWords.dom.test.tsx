import React from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import en from '@/renderer/services/i18n/locales/en-US/common.json';
import zhCN from '@/renderer/services/i18n/locales/zh-CN/common.json';
import zhTW from '@/renderer/services/i18n/locales/zh-TW/common.json';
import Board from '@/renderer/pages/conversation/KyrnPanel/Board';
import { toBoardUpdate } from '@/renderer/pages/conversation/KyrnPanel/Board/board';
import { boardWords } from '@/renderer/pages/conversation/KyrnPanel/Board/wording';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'zh-CN',
    fallbackLng: 'en-US',
    resources: {
      'en-US': { translation: { common: en } },
      'zh-CN': { translation: { common: zhCN } },
      'zh-TW': { translation: { common: zhTW } },
    },
    interpolation: { escapeValue: false },
  });
});
afterEach(cleanup);

let next = 0;
const event = (kind: string, payload: Record<string, unknown>): Activity => ({
  id: `e${++next}`,
  at: next,
  kind,
  payload,
});
/**
 * A fixed board as the harness writes it when the model did not answer: in English, because the person typed
 * English, though the app is in Chinese.
 */
const fixed = (payload: Record<string, unknown> = {}) =>
  event('board.update', {
    progress: '3 of 5 things on the checklist are done.',
    now: 'Running the tests or checks to see whether the change works. (On: tests for the login page)',
    confirm: [],
    confirmCodes: [],
    phase: 'checking',
    focusText: 'tests for the login page',
    needsUser: false,
    done: 3,
    total: 5,
    by: 'rules',
    ended: false,
    ...payload,
  });

const show = (events: Activity[]) =>
  render(
    <I18nextProvider i18n={i18n}>
      <Board events={[event('board.switched', { on: true, cwd: '/work/app' }), ...events]} conversationId='conv' />
    </I18nextProvider>
  );

describe('a fixed board in the app’s language', () => {
  it('is rebuilt from its facts: how far, what now and the item’s own words, what waits on you', () => {
    show([
      fixed({
        needsUser: true,
        confirm: ['It waits for your reply.', 'Keep the old API?'],
        confirmCodes: ['waiting_reply', null],
      }),
    ]);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent(
      '正在跑测试或检查，看改得对不对。（在做：tests for the login page）'
    );
    expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('清单上 5 件事，做完了 3 件。');
    // The agent's own question is its words and stays.
    expect(screen.getAllByTestId('mu-board-confirm').map((item) => item.textContent)).toEqual([
      '它在等你回复。',
      'Keep the old API?',
    ]);
  });

  it('says none yet and all done, in each language', async () => {
    show([fixed({ done: 0, total: 0, phase: undefined, focusText: undefined })]);
    expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('还没有列出要做完的事。');
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('正在干活。');
    cleanup();
    await i18n.changeLanguage('en-US');
    try {
      show([fixed({ done: 1, total: 1 })]);
      expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('The 1 thing on the checklist is done.');
      cleanup();
      show([fixed({ done: 4, total: 4 })]);
      expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('All 4 things on the checklist are done.');
    } finally {
      await i18n.changeLanguage('zh-CN');
    }
  });

  it('leaves a board the model wrote, and one from a harness that sends no codes, as they were written', () => {
    show([fixed({ by: 'model', now: 'Writing the login tests', progress: 'Half way there.' })]);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('Writing the login tests');
    cleanup();
    // An older harness: no codes, so its sentence (which may name the item) is kept whole.
    show([fixed({ confirmCodes: undefined, focusText: undefined })]);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('(On: tests for the login page)');
    expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('3 of 5 things on the checklist are done.');
  });
});

describe('reading a fixed board’s codes', () => {
  it('keeps each code with its line through the filtering, and says when the harness sent codes at all', () => {
    const update = toBoardUpdate(
      fixed({
        confirm: ['', 'Keep the old API?', 'It waits for your reply.'],
        confirmCodes: ['waiting_reply', null, 'waiting_reply'],
      })
    );
    expect(update).toMatchObject({
      confirm: ['Keep the old API?', 'It waits for your reply.'],
      confirmCodes: [null, 'waiting_reply'],
      focusText: 'tests for the login page',
    });
    expect(toBoardUpdate(fixed({ confirmCodes: [] }))?.confirmCodes).toEqual([]);
    expect(toBoardUpdate(fixed({ confirmCodes: undefined }))?.confirmCodes).toBeUndefined();
    expect(toBoardUpdate(fixed({ confirm: ['x'], confirmCodes: ['Waiting Reply!'] }))?.confirmCodes).toEqual([null]);
  });

  it('keeps the harness’s sentence for a part it has no wording for', () => {
    const update = toBoardUpdate(fixed({ needsUser: true, confirm: ['It waits.'], confirmCodes: ['waiting_reply'] }))!;
    const none = boardWords(
      update,
      (key) => key,
      () => false,
      String
    );
    expect(none).toEqual({ now: update.now, progress: update.progress, confirm: ['It waits.'] });
    // The stage has a sentence but the item cannot be named: the harness's sentence, which names it, stays.
    const noFocus = boardWords(
      update,
      (key) => `[${key}]`,
      (key) => !key.endsWith('.focus'),
      String
    );
    expect(noFocus.now).toBe(update.now);
  });
});
