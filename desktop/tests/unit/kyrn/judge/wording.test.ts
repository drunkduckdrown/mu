import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance, type TFunction } from 'i18next';
import {
  answerLabel,
  hintLines,
  JUDGE_ERROR_KINDS,
  JUDGE_REASONS,
  PREFLIGHT_HINT_IDS,
  PREFLIGHT_QUESTION_IDS,
  reasonText,
} from '../../../../packages/desktop/src/renderer/pages/conversation/KyrnPanel/Judge/wording';
import common from '../../../../packages/desktop/src/renderer/services/i18n/locales/en-US/common.json';
import zhCN from '../../../../packages/desktop/src/renderer/services/i18n/locales/zh-CN/common.json';
import zhTW from '../../../../packages/desktop/src/renderer/services/i18n/locales/zh-TW/common.json';

const copy = common.kyrn.judgeView;
const zh = zhCN.kyrn.judgeView;

let en: TFunction;
let chinese: TFunction;
beforeAll(async () => {
  const make = async (lng: string, translation: Record<string, unknown>) => {
    const i18n = createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation } }, interpolation: { escapeValue: false } });
    return i18n.t;
  };
  en = await make('en-US', { common });
  chinese = await make('zh-CN', { common: zhCN });
});

/** The harness's own sentences (packages/kyrn-judge/src/extension/features/preflight.ts, PREFLIGHT_HINTS). */
const HINTS = {
  clarify: 'The request looks under-specified. Ask one focused clarifying question before doing significant work.',
  plan_first: 'This looks like a large or risky change. Write a short plan and confirm the approach before editing.',
};

describe('JeV card wording: the judge’s reason', () => {
  it('names every judge error kind and keeps an unknown kind as recorded', () => {
    for (const kind of JUDGE_ERROR_KINDS) {
      const label = (copy.values as Record<string, string>)[kind];
      expect(reasonText(en, 'en-US', `error:${kind}`)).toBe(`${copy.values.error} · ${label}`);
    }
    expect(reasonText(chinese, 'zh-CN', 'error:rate_limited')).toBe(`${zh.values.error} · ${zh.values.rate_limited}`);
    expect(reasonText(en, 'en-US', 'error:quota_gone')).toBe(`${copy.values.error} · quota_gone`);
  });

  it('names the reasons that are no error, and shows a code it does not know as recorded', () => {
    expect(reasonText(en, 'en-US', 'abstain')).toBe(copy.values.abstain);
    expect(reasonText(en, 'en-US', 'shadow')).toBe(copy.values.shadow);
    expect(reasonText(chinese, 'zh-CN', 'skipped')).toBe(zh.values.skipped);
    expect(reasonText(chinese, 'zh-CN', 'verdict')).toBe(zh.values.verdict);
    expect(reasonText(en, 'en-US', 'no_answer')).toBe(copy.values.no_answer);
    expect(reasonText(en, 'en-US', 'someday_reason')).toBe('someday_reason');
    // A code this build has no words for says what the record says in English.
    expect(reasonText(chinese, 'zh-CN', 'budget_spent', undefined, 'the judge budget is spent')).toBe(
      'the judge budget is spent'
    );
    // A known code never shows the English beside it.
    expect(reasonText(chinese, 'zh-CN', 'skipped', undefined, 'skipped by the user')).toBe(zh.values.skipped);
    expect(reasonText(en, 'en-US', '')).toBe('');
  });

  it('says how long a wait without an answer lasted, in the app language', () => {
    expect(reasonText(en, 'en-US', 'no_answer', { seconds: 6 })).toMatch(/^No answer after 6\s?sec/);
    expect(reasonText(chinese, 'zh-CN', 'no_answer', { seconds: 6 })).toMatch(/^6\s?秒内未得到回答$/);
  });

  it('has words for every reason and error kind in each reference language', () => {
    for (const locale of [common, zhCN, zhTW]) {
      const view = locale.kyrn.judgeView;
      const values = view.values as Record<string, string>;
      for (const code of [...JUDGE_ERROR_KINDS, ...JUDGE_REASONS, 'error']) expect(values[code]).toBeTruthy();
      expect(view.noAnswerAfter).toContain('{{duration}}');
    }
  });
});

describe('JeV card wording: hints and answers', () => {
  it('says each hint by its id and keeps the recorded sentence where there is none', () => {
    expect(hintLines(en, [HINTS.clarify, HINTS.plan_first], ['clarify', 'plan_first'])).toEqual([
      copy.hints.clarify,
      copy.hints.plan_first,
    ]);
    expect(hintLines(chinese, [HINTS.clarify], ['clarify'])).toEqual([zh.hints.clarify]);
    // Older records carry the sentences only; an id this build does not know falls back to its sentence.
    expect(hintLines(chinese, ['Write a short plan.'], [])).toEqual(['Write a short plan.']);
    expect(hintLines(chinese, ['A new hint.', HINTS.clarify], ['new_hint', 'clarify'])).toEqual([
      'A new hint.',
      zh.hints.clarify,
    ]);
    expect(hintLines(en, [], [])).toEqual([]);
  });

  it('names the preflight’s questions and leaves other ids as recorded', () => {
    expect(answerLabel(en, 'preflight', 'turn_type')).toBe(copy.answerIds.turn_type);
    expect(answerLabel(chinese, 'preflight', 'needs_clarification')).toBe(zh.answerIds.needs_clarification);
    expect(answerLabel(chinese, 'rewind', 'dead_end')).toBe('dead_end');
    expect(answerLabel(en, 'preflight', 'Turn type')).toBe('Turn type');
    // Another decision point's question that shares an id is not named as the preflight's.
    expect(answerLabel(chinese, 'drift', 'plan_first')).toBe('plan_first');
  });

  it('has words for every hint and question id in each reference language', () => {
    for (const locale of [common, zhCN, zhTW]) {
      const view = locale.kyrn.judgeView;
      for (const id of PREFLIGHT_HINT_IDS) expect((view.hints as Record<string, string>)[id]).toBeTruthy();
      for (const id of PREFLIGHT_QUESTION_IDS) expect((view.answerIds as Record<string, string>)[id]).toBeTruthy();
    }
  });
});
