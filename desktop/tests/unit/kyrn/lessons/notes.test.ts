import { createInstance, type TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StoredLesson } from '@/common/kyrn/lessons';
import type { Activity } from '@/common/kyrn/types';
import { lessonMatches, memoryEvents, shownLessons } from '@/renderer/pages/conversation/KyrnPanel/Lessons/model';
import { lessonNotes } from '@/renderer/pages/conversation/KyrnPanel/Lessons/notes';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import zhCN from '@/renderer/services/i18n/locales/zh-CN/common.json';

const lesson = (id: string, extra: Partial<StoredLesson> = {}): StoredLesson => ({
  id,
  kind: 'correction',
  trigger: `when ${id} comes up`,
  lesson: `Do ${id}.`,
  scope: { cwd: '/work/app' },
  source: { origin: 'user' },
  status: 'active',
  uses: { recalled: 0, applied: 0 },
  created: '2026-09-20T00:00:00.000Z',
  updated: '2026-09-20T00:00:00.000Z',
  ...extra,
});

let next = 0;
const event = (kind: string, payload: Record<string, unknown>): Activity => ({
  id: `event-${++next}`,
  at: 1_000 + next,
  kind,
  payload,
});

let en: TFunction;
let zh: TFunction;
beforeAll(async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { common } }, 'zh-CN': { translation: { common: zhCN } } },
    interpolation: { escapeValue: false },
  });
  en = i18n.getFixedT('en-US');
  zh = i18n.getFixedT('zh-CN');
});

describe('the rows of the lessons tab', () => {
  const lessons = [
    lesson('old-rule', { uses: { recalled: 9, applied: 1 }, updated: '2026-09-01T00:00:00.000Z' }),
    lesson('retired', { status: 'retired', uses: { recalled: 8, applied: 0 } }),
    lesson('new-rule', { uses: { recalled: 2, applied: 1 }, updated: '2026-09-22T00:00:00.000Z' }),
    lesson('replaced', { status: 'superseded', uses: { recalled: 3, applied: 3 } }),
    lesson('followed', { uses: { recalled: 4, applied: 4 } }),
  ];

  it('lists the lessons in use, the most followed first, then the latest written or confirmed', () => {
    expect(shownLessons(lessons, 'active').map((row) => row.id)).toEqual(['followed', 'new-rule', 'old-rule']);
  });

  it('adds the retired and replaced ones after them under all, in the same order', () => {
    expect(shownLessons(lessons, 'all').map((row) => row.id)).toEqual([
      'followed',
      'new-rule',
      'old-rule',
      'replaced',
      'retired',
    ]);
  });

  it('finds a lesson by every word searched for, in what it says, when it applies or its kind', () => {
    const row = lesson('x', { lesson: 'Run ./test.sh from the root.', trigger: 'Running the unit tests' });
    expect(lessonMatches(row, 'TEST.SH root', 'Correction')).toBe(true);
    expect(lessonMatches(row, 'unit correction', 'Correction')).toBe(true);
    expect(lessonMatches(row, 'test.sh vitest', 'Correction')).toBe(false);
    expect(lessonMatches(row, '   ', 'Correction')).toBe(true);
  });

  it('follows only what the harness says about lessons', () => {
    const kinds = memoryEvents([
      event('memory.stored', {}),
      event('decision', {}),
      event('memory.recalled', {}),
      event('memory.applied', {}),
      event('memory.retired', {}),
      event('memory.merged', {}),
      event('board.update', {}),
    ]).map((item) => item.kind);
    expect(kinds).toEqual(['memory.stored', 'memory.recalled', 'memory.applied', 'memory.retired', 'memory.merged']);
  });
});

describe('the quiet notes above the lessons', () => {
  const kept = [
    lesson('a1111111-0000-4000-8000-000000000000', { lesson: 'Use ./test.sh.', uses: { recalled: 8, applied: 0 } }),
    lesson('b2222222-0000-4000-8000-000000000000', { lesson: 'Keep the icons pale.' }),
    lesson('c3333333-0000-4000-8000-000000000000', { lesson: 'Say "unit" for tests.' }),
  ];
  const [a, b, c] = kept.map((row) => row.id);
  const texts = (t: TFunction, events: Activity[], limit?: number) =>
    lessonNotes(t, events, kept, limit).map((note) => note.text);

  it('says how many lessons a turn brought in and how many were followed', () => {
    const events = [event('memory.recalled', { ids: [a, b], turn: 2 }), event('memory.applied', { ids: [a] })];
    expect(texts(en, events)).toEqual(['1 lesson was followed', 'This turn brought in 2 lessons']);
    expect(texts(zh, events)).toEqual(['照做了 1 条', '这一轮用上了 2 条']);
  });

  it('names the task when the lessons went into a sub-agent’s brief', () => {
    const events = [event('memory.recalled', { ids: [c], turn: 3, task: 'Fix the login test' })];
    expect(texts(en, events)).toEqual(['A sub-agent’s brief carried 1 lesson: Fix the login test']);
  });

  it('adds nothing for a stored lesson, a recall without ids or a followed list that is empty', () => {
    const events = [
      event('memory.stored', kept[0] as unknown as Record<string, unknown>),
      event('memory.recalled', { content: 'Lessons from earlier sessions:\n- Use ./test.sh.' }),
      event('memory.applied', { ids: [] }),
    ];
    expect(texts(en, events)).toEqual([]);
  });

  it('says why a lesson was retired, with the recalls the file counts for one never followed', () => {
    expect(texts(zh, [event('memory.retired', { id: a, reason: 'unused' })])).toEqual([
      '退役：Use ./test.sh.（8 次召回从未照做）',
    ]);
    expect(texts(en, [event('memory.retired', { id: a, reason: 'unused' })])).toEqual([
      'Retired: Use ./test.sh. (recalled 8 times, never followed)',
    ]);
    expect(texts(en, [event('memory.retired', { id: b, reason: 'unused' })])).toEqual([
      'Retired: Keep the icons pale.',
    ]);
    expect(texts(en, [event('memory.retired', { id: b, reason: 'forgotten' })])).toEqual([
      'Retired: Keep the icons pale. (at your request)',
    ]);
  });

  it('names the lesson that stands after a merge, and leaves a contradiction the user settled to its retirement', () => {
    const fresh = 'd4444444-0000-4000-8000-000000000000';
    expect(texts(zh, [event('memory.merged', { id: fresh, into: b, how: 'same' })])).toEqual([
      '已并入：Keep the icons pale.',
    ]);
    expect(texts(en, [event('memory.merged', { id: b, into: c, how: 'refines' })])).toEqual([
      'Kept a more precise wording: Say "unit" for tests.',
    ]);
    // A model's lesson outranked by a kept one: it was never stored.
    expect(texts(en, [event('memory.merged', { id: fresh, into: a, how: 'contradicts' })])).toEqual([
      'Not kept, it contradicts: Use ./test.sh.',
    ]);
    // The user's newer word: the merge line and then the retirement of the old lesson, said once.
    expect(
      texts(en, [
        event('memory.merged', { id: a, into: fresh, how: 'contradicts' }),
        event('memory.retired', { id: a, reason: 'contradicted' }),
      ])
    ).toEqual(['Retired: Use ./test.sh. (your newer word contradicts it)']);
  });

  it('names a lesson the file does not hold by the start of its id', () => {
    expect(texts(en, [event('memory.retired', { id: 'e5555555-0000-4000-8000-000000000000' })])).toEqual([
      'Retired: e5555555',
    ]);
  });

  it('shows the latest first, three at most, each with its event’s time', () => {
    const events = [
      event('memory.recalled', { ids: [a] }),
      event('memory.applied', { ids: [a] }),
      event('memory.recalled', { ids: [a, b, c] }),
      event('memory.applied', { ids: [a, b] }),
    ];
    const notes = lessonNotes(en, events, kept);
    expect(notes.map((note) => note.text)).toEqual([
      '2 lessons were followed',
      'This turn brought in 3 lessons',
      '1 lesson was followed',
    ]);
    expect(notes.map((note) => note.at)).toEqual([events[3].at, events[2].at, events[1].at]);
    expect(texts(en, events, 10)).toHaveLength(4);
  });
});
