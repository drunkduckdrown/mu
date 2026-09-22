import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import type { Activity, ActivityPage, Result } from '@/common/kyrn/types';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import KyrnPanel from '@/renderer/pages/conversation/KyrnPanel';
import Judge from '@/renderer/pages/conversation/KyrnPanel/Judge';
import { event, gate, ledger, turn, verdict } from './judgeFixtures';

const { activity } = vi.hoisted(() => ({ activity: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { activity: { invoke: activity } },
  unwrap: (result: Result<ActivityPage>) => {
    if (result.ok === false) throw new Error(result.error);
    return result.data;
  },
}));

const copy = common.kyrn.judgeView;
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

const view = (events: Activity[]) =>
  render(
    <I18nextProvider i18n={i18n}>
      <Judge events={events} />
    </I18nextProvider>
  );
const cards = () => screen.getAllByTestId('judge-card');

describe('JeV panel', () => {
  it('shows each judgment as question, verdict and effect, with probabilities and JSON held back', () => {
    view([
      event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 1, 2)),
      event('decision', ledger({ state: { user_message: 'PRIVATE JUDGE INPUT' } }), turn('runtime-a', 1, 3)),
      event(
        'preflight.verdict',
        verdict({ thinking: { from: 'medium', to: 'high' }, hints: ['Write a short plan.'] }),
        {
          ...turn('runtime-a', 1, 4),
        }
      ),
    ]);

    const card = within(cards()[0]);
    expect(card.getByText(copy.question)).toBeInTheDocument();
    expect(card.getByText(copy.questions.preflight)).toBeInTheDocument();
    expect(card.getByText(copy.result)).toBeInTheDocument();
    expect(card.getByText(copy.values.multi_step_task)).toBeInTheDocument();
    expect(card.getByText(copy.action)).toBeInTheDocument();
    expect(card.getByText(copy.actions.mainGiven)).toBeInTheDocument();
    expect(card.getByText('Thinking level: Medium → High')).toBeInTheDocument();
    expect(card.getByText('Write a short plan.')).toBeInTheDocument();
    expect(card.getByText(copy.state.confirmed)).toBeInTheDocument();

    // Raw probabilities and records are details, not the headline.
    expect(card.queryByText(/stateDigest/)).not.toBeInTheDocument();
    expect(card.queryByText(/55%/)).not.toBeInTheDocument();
    fireEvent.click(card.getByText(copy.details));
    expect(card.getByText(/Multi-step task 55%/)).toBeInTheDocument();
    expect(card.getByText(/"stateDigest": "digest"/)).toBeInTheDocument();
    // The judge's own input is never part of the view, even when a diagnostic build recorded it.
    expect(card.queryByText(/PRIVATE JUDGE INPUT/)).not.toBeInTheDocument();
  });

  it('never words a handed-over verdict as a finished operation', () => {
    view([event('preflight.verdict', verdict(), turn('runtime-a', 1, 2))]);

    const card = within(cards()[0]);
    expect(card.getByText(copy.state.returned)).toBeInTheDocument();
    expect(card.getByText(copy.actions.toRuntime)).toBeInTheDocument();
    expect(copy.actions.toRuntime).toMatch(/not proof that the operation completed/);
    expect(card.queryByText(copy.state.confirmed)).not.toBeInTheDocument();
    expect(card.queryByText(copy.actions.mainGiven)).not.toBeInTheDocument();
  });

  it('labels shadow, late, fallback and rule verdicts with different words and effects', () => {
    view([
      event('preflight.verdict', verdict({ state: 'shadow' }), turn('runtime-a', 1, 2)),
      event('preflight.verdict', verdict({ state: 'late' }), turn('runtime-a', 2, 6)),
      event('preflight.verdict', verdict({ state: 'none', by: 'rule', turnType: 'unknown', reason: 'error:timeout' }), {
        ...turn('runtime-a', 3, 10),
      }),
      event('preflight.verdict', verdict({ by: 'rule', turnType: 'chat', gear: 'chat' }), turn('runtime-a', 4, 14)),
    ]);

    const [rule, fallback, late, shadow] = cards().map((card) => within(card));
    expect(shadow.getByText(copy.state.shadow)).toBeInTheDocument();
    expect(shadow.getByText(copy.actions.observeOnly)).toBeInTheDocument();
    expect(late.getByText(copy.state.late)).toBeInTheDocument();
    expect(late.getByText(copy.actions.lateIgnored)).toBeInTheDocument();
    expect(fallback.getByText(copy.state.fallback)).toBeInTheDocument();
    expect(fallback.getByText(copy.actions.useDefault)).toBeInTheDocument();
    expect(
      fallback.getByText(`${copy.fields.reason}: ${copy.values.error} · ${copy.values.timeout}`)
    ).toBeInTheDocument();
    expect(rule.getByText(copy.state.rule)).toBeInTheDocument();
    expect(
      new Set([copy.state.shadow, copy.state.late, copy.state.fallback, copy.state.rule, copy.state.returned]).size
    ).toBe(5);
    expect(cards().map((card) => card.getAttribute('data-state'))).toEqual(['rule', 'fallback', 'late', 'shadow']);
    // A default is described as a default, never as permission.
    expect(copy.actions.useDefault).toMatch(/not permission to proceed/);
  });

  it('separates permission to deliver from a confirmed delivery', () => {
    view([
      event('hive.gate', gate({ gate: 'deliver', from: 'scout', to: 'worker', note: 'note-1', deliver: true }), {
        run: 'run-1',
      }),
      event('hive.gate', gate({ gate: 'deliver', from: 'scout', to: 'reviewer', note: 'note-1', deliver: true }), {
        run: 'run-1',
      }),
      event('hive.note', { id: 'note-1', bee: 'scout', kind: 'finding', text: 'Prefix is stable.' }, { run: 'run-1' }),
      event('hive.delivery', { note: 'note-1', to: 'worker', score: 0.8 }, { run: 'run-1' }),
    ]);

    const [toReviewer, toWorker] = cards().map((card) => within(card));
    expect(toWorker.getByText(copy.actions.delivered)).toBeInTheDocument();
    expect(toWorker.getByText(copy.state.confirmed)).toBeInTheDocument();
    expect(toReviewer.getByText(copy.actions.allowDelivery)).toBeInTheDocument();
    expect(toReviewer.queryByText(copy.actions.delivered)).not.toBeInTheDocument();
    expect(toReviewer.getByText('Prefix is stable.')).toBeInTheDocument();
    expect(screen.getByText(copy.receiptCount).nextElementSibling).toHaveTextContent('1');
  });

  it('shows a conservative fallback as refused, with the number of unanswered candidates', () => {
    view([
      event('hive.gate', gate({ gate: 'publish', bee: 'scout', publish: false, score: 0, reason: 'error:timeout' }), {
        run: 'run-1',
      }),
      event(
        'decision',
        ledger({
          id: 'admission-1',
          specId: 'tool.admission',
          source: 'fallback',
          reason: 'error:all',
          outcome: [{ kind: 'unknown', drop: false }],
          answers: undefined,
          batch: { size: 4, failures: 4 },
        }),
        turn('runtime-a', 1, 8)
      ),
    ]);

    const [admission, publish] = cards().map((card) => within(card));
    expect(publish.getByText(copy.state.fallback)).toBeInTheDocument();
    expect(publish.getByText(`${copy.fields.publish}`).parentElement).toHaveTextContent(copy.values.false);
    expect(publish.queryByText(copy.actions.allowPublish)).not.toBeInTheDocument();
    expect(admission.getByText(/Candidates covered by this record: 4\./)).toBeInTheDocument();
    expect(admission.getByText(/default strategy used: 4\./)).toBeInTheDocument();
  });

  it('does not present token savings, cost or a model reasoning trace', () => {
    view([
      event('decision', ledger({ usage: { inputTokens: 321, outputTokens: 12 } }), turn('runtime-a', 1, 3)),
      event('preflight.verdict', verdict(), turn('runtime-a', 1, 4)),
    ]);

    // Usage stays inside the raw record; the summary makes no claim about savings or cost.
    expect(screen.getByTestId('kyrn-judge').textContent).not.toMatch(
      /token|saving|saved|cost|\$|chain of thought|reasoning/i
    );
    expect(JSON.stringify(copy)).not.toMatch(/token|saving|saved|cost|chain of thought/i);
  });

  it('marks an uncorrelated record as standing alone', () => {
    view([event('preflight.verdict', verdict()), event('preflight.verdict', verdict())]);

    expect(cards()).toHaveLength(2);
    expect(screen.getAllByText(copy.unlinked)).toHaveLength(2);
  });

  it('filters by what was judged', async () => {
    view([
      event('preflight.verdict', verdict(), turn('runtime-a', 1, 2)),
      event('decision', ledger({ id: 'drift-1', specId: 'turn.drift', outcome: 'on_track' }), turn('runtime-a', 1, 5)),
    ]);
    expect(cards()).toHaveLength(2);

    fireEvent.click(screen.getByRole('combobox', { name: copy.filter }));
    fireEvent.click(await screen.findByText(`${copy.questions.drift} · 1`));

    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(within(cards()[0]).getByText(copy.values.on_track)).toBeInTheDocument();
  });

  it('is the JeV tab of the collaboration panel, with other runtime events listed under it', async () => {
    activity.mockResolvedValue({
      ok: true,
      data: {
        sessionId: 'session',
        cursor: 1,
        more: false,
        events: [
          event('preflight.verdict', verdict(), turn('runtime-a', 1, 2)),
          event('agent_start', {}),
          event('agent_settled', {}),
        ],
      },
    });
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <KyrnPanel conversationId='conv' />
        </MemoryRouter>
      </I18nextProvider>
    );
    fireEvent.click(screen.getByRole('tab', { name: common.kyrn.decisions }));

    expect(await screen.findByText(copy.title)).toBeInTheDocument();
    expect(cards()).toHaveLength(1);
    expect(screen.getByText(`${copy.runtimeEvents} · 2`)).toBeInTheDocument();
    // The verdict is a card now, not a second raw row in the event list.
    expect(screen.queryByText(common.kyrn.event['preflight.verdict'])).not.toBeInTheDocument();
  });

  it('says so when nothing was judged', () => {
    view([event('agent_start', {})]);

    expect(screen.getByText(copy.empty)).toBeInTheDocument();
    expect(screen.queryByTestId('judge-card')).not.toBeInTheDocument();
  });

  it('names the reason of a fallback in words, including a wait without an answer and every judge error', () => {
    view([
      event('preflight.verdict', verdict({ state: 'none', reason: 'no answer after 6.0 s', waitedMs: 6000 }), {
        ...turn('runtime-a', 1, 2),
      }),
      event(
        'decision',
        ledger({ id: 'risk-1', specId: 'tool.risk', source: 'fallback', reason: 'error:rate_limited' }),
        {
          ...turn('runtime-a', 1, 5),
        }
      ),
    ]);

    const [risk, preflight] = cards().map((card) => within(card));
    expect(preflight.getByText(`Reason: ${copy.values.no_answer}`)).toBeInTheDocument();
    expect(preflight.queryByText(/no answer after/)).not.toBeInTheDocument();
    expect(risk.getByText(`Reason: Error · ${copy.values.rate_limited}`)).toBeInTheDocument();
  });

  it('asks the question of every harness decision point and labels its outcome', () => {
    view([
      event('decision', ledger({ id: 'goal-1', specId: 'goal.met', outcome: 'met' }), turn('runtime-a', 1, 2)),
      event(
        'decision',
        ledger({
          id: 'board-1',
          specId: 'board.read',
          outcome: { phase: 'wrapping_up', focus: null, needsUser: false, update: true },
        }),
        turn('runtime-a', 1, 3)
      ),
    ]);

    const [board, goal] = cards().map((card) => within(card));
    expect(goal.getByText(copy.questions.goalMet)).toBeInTheDocument();
    expect(goal.getByText(copy.values.met)).toBeInTheDocument();
    expect(board.getByText(copy.questions.board)).toBeInTheDocument();
    expect(board.getByText(copy.fields.phase).parentElement).toHaveTextContent(
      common.kyrn.boardView.phases.wrapping_up
    );
    expect(board.getByText(copy.fields.needsUser).parentElement).toHaveTextContent(copy.values.false);
    expect(screen.queryByText(copy.questions.other)).not.toBeInTheDocument();
  });

  it('labels the answers a batch counted as answers, and gives each batch sentence a line of its own', () => {
    view([
      event(
        'decision',
        ledger({
          id: 'forget-1',
          specId: 'context.forget',
          outcome: ['keep', 'shrink', 'keep', 'now'],
          answers: undefined,
          batch: { size: 4, failures: 1 },
        }),
        turn('runtime-a', 1, 2)
      ),
    ]);

    const card = within(cards()[0]);
    // The counted answers are values ("Keep"), never a field's label ("Suggested retention") or the raw id.
    expect(card.getByText(copy.values.keep).parentElement).toHaveTextContent(`${copy.values.keep}×2`);
    expect(card.getByText(copy.values.shrink).parentElement).toHaveTextContent(`${copy.values.shrink}×1`);
    expect(card.getByText(copy.values.now)).toBeInTheDocument();
    expect(card.queryByText(copy.fields.keep)).not.toBeInTheDocument();
    expect(card.queryByText('shrink')).not.toBeInTheDocument();
    expect(card.getByText('Candidates covered by this record: 4.')).toBeInTheDocument();
    expect(card.getByText('Without an answer, default strategy used: 1.')).toBeInTheDocument();
  });

  it('formats numbers in the app language rather than the operating system’s', async () => {
    const german = createInstance();
    await german.init({
      lng: 'de-DE',
      fallbackLng: 'en',
      resources: { en: { translation: { common, mu } } },
      interpolation: { escapeValue: false },
    });
    render(
      <I18nextProvider i18n={german}>
        <Judge
          events={[
            event(
              'decision',
              ledger({
                latencyMs: 12_345,
                answers: { ok: { type: 'boolean', probability: 0.925 }, fit: { type: 'score', score: 0.5 } },
              }),
              turn('runtime-a', 1, 2)
            ),
          ]}
        />
      </I18nextProvider>
    );

    const card = within(cards()[0]);
    expect(card.getByText(/12\.345 ms/)).toBeInTheDocument();
    fireEvent.click(card.getByText(copy.details));
    expect(card.getByText(/Probability of yes: 93\s%/)).toBeInTheDocument();
    expect(card.getByText(/Score: 0,50/)).toBeInTheDocument();
  });

  it('keeps Chinese punctuation and list separators inside the Chinese texts', async () => {
    const chinese = createInstance();
    await chinese.init({
      lng: 'zh-CN',
      resources: { 'zh-CN': { translation: { common: zhCommon, mu: zhMu } } },
      interpolation: { escapeValue: false },
    });
    const zh = zhCommon.kyrn.judgeView;
    render(
      <I18nextProvider i18n={chinese}>
        <Judge
          events={[
            event(
              'preflight.verdict',
              verdict({ thinking: { from: 'medium', to: 'xhigh' }, reason: 'error:timeout' }),
              turn('runtime-a', 1, 2)
            ),
            event(
              'decision',
              ledger({ id: 'skills-1', specId: 'skills.disclosure', outcome: { relevant: ['git', 'deploy', 'docs'] } }),
              turn('runtime-a', 1, 5)
            ),
          ]}
        />
      </I18nextProvider>
    );

    const [skills, preflight] = cards().map((card) => within(card));
    expect(preflight.getByText(`原因：${zh.values.error} · ${zh.values.timeout}`)).toBeInTheDocument();
    expect(preflight.getByText(`思考强度：${zhMu.levels.medium} → ${zhMu.levels.xhigh}`)).toBeInTheDocument();
    expect(skills.getByText(zh.fields.relevant).parentElement).toHaveTextContent('git、deploy和docs');
  });
});
