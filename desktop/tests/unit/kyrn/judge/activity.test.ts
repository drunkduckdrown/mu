import { describe, expect, it } from 'vitest';
import {
  answerRows,
  DECISIONS,
  judgeCards,
  reasonCode,
  resultFacts,
  runtimeEvents,
  stageOf,
} from '../../../../packages/desktop/src/renderer/pages/conversation/KyrnPanel/Judge/activity';
import common from '../../../../packages/desktop/src/renderer/services/i18n/locales/en-US/common.json';
import zhCN from '../../../../packages/desktop/src/renderer/services/i18n/locales/zh-CN/common.json';
import zhTW from '../../../../packages/desktop/src/renderer/services/i18n/locales/zh-TW/common.json';
import { event, gate, ledger, turn, verdict } from './judgeFixtures';

describe('JeV judgment cards: what is folded together', () => {
  it('folds the phases of one classification that share a runtime and a turn', () => {
    const cards = judgeCards([
      event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 3, 20)),
      event('decision', ledger(), turn('runtime-a', 3, 21)),
      event('preflight.verdict', verdict(), turn('runtime-a', 3, 22)),
      event('preflight.wait_end', { reason: 'verdict', waitedMs: 702 }, turn('runtime-a', 3, 23)),
      event('preflight.verdict', verdict(), turn('runtime-a', 3, 25)),
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ stage: 'preflight', state: 'returned', unlinked: false, model: 'jev-1.13.0' });
    expect(cards[0].evidence).toHaveLength(5);
  });

  it('never merges the same turn number across two runtimes', () => {
    // Every runtime counts its turns from 1, so a reconnect repeats the numbers.
    const cards = judgeCards([
      event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 1, 2)),
      event('preflight.verdict', verdict({ turnType: 'chat', gear: 'chat' }), turn('runtime-a', 1, 4)),
      event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-b', 1, 2)),
      event(
        'preflight.verdict',
        verdict({ state: 'late', turnType: 'research', gear: 'heavy' }),
        turn('runtime-b', 1, 4)
      ),
    ]);

    expect(cards).toHaveLength(2);
    const [second, first] = cards;
    expect(first.outcome).toEqual({ turnType: 'chat', gear: 'chat' });
    expect(first.state).toBe('returned');
    expect(second.outcome).toEqual({ turnType: 'research', gear: 'heavy' });
    expect(second.state).toBe('late');
    expect(first.evidence.every((record) => record.runtimeId === 'runtime-a')).toBe(true);
    expect(second.evidence.every((record) => record.runtimeId === 'runtime-b')).toBe(true);
  });

  it('does not treat a runtime id without a turn, or a turn without a runtime id, as correlation', () => {
    const cards = judgeCards([
      event('preflight.verdict', verdict(), { runtimeId: 'runtime-a' }),
      event('preflight.verdict', verdict(), { turnId: 1, sequence: 3 }),
    ]);

    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.unlinked)).toBe(true);
  });

  it('keeps old records without correlation apart, however close in time they are', () => {
    // The shape written before correlation fields existed: five records within three milliseconds.
    const at = 5_000;
    const records = [
      { ...event('preflight.pending', { judge: 'jev-latest', mode: 'active' }), at },
      { ...event('decision', ledger()), at: at + 1 },
      { ...event('preflight.verdict', verdict()), at: at + 1 },
      { ...event('preflight.wait_end', { reason: 'verdict', waitedMs: 650 }), at: at + 2 },
      { ...event('preflight.verdict', verdict({ hints: ['Write a short plan first.'] })), at: at + 3 },
    ];
    const cards = judgeCards(records);

    // The two verdict frames and the ledger record are judgments of their own; none absorbs another.
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.unlinked && card.evidence.length === 1)).toBe(true);
    expect(cards.map((card) => card.evidence[0].kind).toSorted()).toEqual([
      'decision',
      'preflight.verdict',
      'preflight.verdict',
    ]);
    // A lone wait marker is no judgment: it stays an ordinary runtime event instead of being paired up.
    expect(runtimeEvents(records).map((record) => record.kind)).toEqual(['preflight.pending', 'preflight.wait_end']);
  });

  it('does not let a ledger record stamped with a later turn describe that turn', () => {
    // A judge that answers after the next message began is written under the new turn number.
    const [card] = judgeCards([
      event(
        'decision',
        ledger({ id: 'late-from-previous-turn', latencyMs: 15_000, modelId: 'other' }),
        turn('r', 5, 40)
      ),
      event('decision', ledger({ id: 'own', latencyMs: 700 }), turn('r', 5, 41)),
      event('preflight.verdict', verdict({ latencyMs: 700 }), turn('r', 5, 42)),
      event('decision', ledger({ id: 'late-again', latencyMs: 16_000, modelId: 'other' }), turn('r', 5, 43)),
    ]);

    expect(card.model).toBe('jev-1.13.0');
    expect(card.latencyMs).toBe(700);
  });
});

describe('JeV judgment cards: what a verdict did to execution', () => {
  const stateOf = (payload: Record<string, unknown>) =>
    judgeCards([event('preflight.verdict', payload, turn('runtime-a', 1, 2))])[0];

  it('says a returned verdict was handed over, not that the operation completed', () => {
    const card = stateOf(verdict());

    expect(card).toMatchObject({ state: 'returned', action: 'toRuntime' });
    expect(card.thinking).toBeUndefined();
  });

  it('confirms an effect only when an adjustment or hints were recorded as applied', () => {
    expect(stateOf(verdict({ thinking: { from: 'medium', to: 'high' } }))).toMatchObject({
      state: 'confirmed',
      action: 'mainGiven',
      thinking: { from: 'medium', to: 'high' },
    });
    expect(stateOf(verdict({ hints: ['Ask one clarifying question.'] }))).toMatchObject({
      state: 'confirmed',
      hints: ['Ask one clarifying question.'],
    });
    // An unchanged level is not an adjustment.
    expect(stateOf(verdict({ thinking: { from: 'medium', to: 'medium' } })).state).toBe('returned');
  });

  it('keeps shadow, late, fallback and rule verdicts apart from each other and from a returned one', () => {
    const shadow = stateOf(verdict({ state: 'shadow', hints: ['not applied'], thinking: { from: 'low', to: 'high' } }));
    const late = stateOf(verdict({ state: 'late' }));
    const fallback = stateOf(verdict({ state: 'none', by: 'rule', turnType: 'unknown', reason: 'error:timeout' }));
    const rule = stateOf(verdict({ by: 'rule', turnType: 'chat', gear: 'chat' }));

    expect(shadow).toMatchObject({ state: 'shadow', action: 'observeOnly', hints: [] });
    // Observed only: nothing it would have changed is reported as changed.
    expect(shadow.thinking).toBeUndefined();
    expect(late).toMatchObject({ state: 'late', action: 'lateIgnored' });
    expect(fallback).toMatchObject({ state: 'fallback', action: 'useDefault', reason: 'error:timeout' });
    // A rule settled it: it is not shown as the judge's decision, and the judge is not named.
    expect(rule).toMatchObject({ state: 'rule', action: 'useDefault', model: '' });
    expect(new Set([shadow, late, fallback, rule, stateOf(verdict())].map((card) => card.state)).size).toBe(5);
  });

  it('does not name the judge on a rule verdict, even when the same turn recorded which judge was asked', () => {
    const [card] = judgeCards([
      event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 1, 2)),
      event('decision', ledger({ source: 'fallback', reason: 'abstain' }), turn('runtime-a', 1, 3)),
      event('preflight.verdict', verdict({ by: 'rule', turnType: 'chat', gear: 'chat' }), turn('runtime-a', 1, 4)),
    ]);

    expect(card).toMatchObject({ state: 'rule', model: '' });
    // What was asked stays available as evidence; it is only kept out of the byline.
    expect(card.evidence).toHaveLength(3);
  });

  it('reads a wait without any verdict as a wait, a timeout, or an ended wait', () => {
    const pending = event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 1, 2));
    expect(judgeCards([pending])[0]).toMatchObject({ state: 'pending', action: 'waiting', model: 'jev-latest' });

    const timedOut = event('preflight.wait_end', { reason: 'timeout', waitedMs: 6_002 }, turn('runtime-a', 1, 3));
    expect(judgeCards([pending, timedOut])[0]).toMatchObject({
      state: 'fallback',
      action: 'useDefault',
      latencyMs: 6_002,
    });

    // The task that followed has settled: whatever that wait was, it is not still running.
    const settled = { ...event('agent_settled', {}), at: pending.at + 60_000 };
    expect(judgeCards([pending, settled])[0]).toMatchObject({ state: 'ended', action: 'waitEnded' });
    const nextTurn = event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 2, 9));
    expect(judgeCards([pending, nextTurn]).find((card) => card.id.includes(',1]'))?.state).toBe('ended');
  });

  it('shows what an observe-only judge would have said, while reporting that nothing changed', () => {
    const [card] = judgeCards([
      event(
        'decision',
        ledger({
          specId: 'tool.risk',
          mode: 'shadow',
          source: 'fallback',
          reason: 'shadow',
          outcome: 'confirm',
          judged: 'allow',
        }),
        turn('runtime-a', 2, 9)
      ),
    ]);

    expect(card).toMatchObject({ stage: 'risk', state: 'shadow', action: 'observeOnly', outcome: 'allow' });
  });

  it('does not read a fallback as a pass: the risk gate falls back to asking the user', () => {
    const [card] = judgeCards([
      event(
        'decision',
        ledger({
          specId: 'tool.risk',
          source: 'fallback',
          reason: 'error:timeout',
          outcome: 'confirm',
          modelId: undefined,
        }),
        turn('runtime-a', 2, 9)
      ),
    ]);

    expect(card).toMatchObject({ stage: 'risk', state: 'fallback', action: 'useDefault', outcome: 'confirm' });
    expect(resultFacts(card)).toEqual([{ name: 'result', values: ['confirm'] }]);
  });

  it('reports how much of a batch got no answer', () => {
    const [card] = judgeCards([
      event(
        'decision',
        ledger({
          specId: 'tool.admission',
          outcome: [
            { kind: 'result', drop: false },
            { kind: 'progress', drop: true },
            { kind: 'unknown', drop: false },
          ],
          answers: undefined,
          batch: { size: 3, failures: 1, answers: [null, null, null] },
        }),
        turn('runtime-a', 2, 9)
      ),
    ]);

    expect(card.batch).toEqual({ size: 3, failures: 1 });
    expect(resultFacts(card)).toEqual([
      { name: 'drop', values: ['1'] },
      { name: 'keep', values: ['2'] },
    ]);
  });
});

describe('JeV judgment cards: Hive gates', () => {
  const deliverGate = (overrides: Record<string, unknown> = {}) =>
    event(
      'hive.gate',
      gate({ gate: 'deliver', from: 'scout', to: 'worker', note: 'note-1', deliver: true, ...overrides }),
      {
        run: 'run-1',
      }
    );

  it('calls a delivery delivered only when a receipt for that run, note and bee exists', () => {
    const allowed = deliverGate();
    expect(judgeCards([allowed])[0]).toMatchObject({ state: 'returned', action: 'allowDelivery' });

    const receipt = event('hive.delivery', { note: 'note-1', to: 'worker', score: 0.8 }, { run: 'run-1' });
    expect(judgeCards([allowed, receipt])[0]).toMatchObject({ state: 'confirmed', action: 'delivered' });
  });

  it('does not borrow a receipt from another run, another bee or another note', () => {
    const allowed = deliverGate();
    for (const receipt of [
      event('hive.delivery', { note: 'note-1', to: 'worker' }, { run: 'run-2' }),
      event('hive.delivery', { note: 'note-1', to: 'reviewer' }, { run: 'run-1' }),
      event('hive.delivery', { note: 'note-2', to: 'worker' }, { run: 'run-1' }),
    ]) {
      expect(judgeCards([allowed, receipt])[0].action).toBe('allowDelivery');
    }
  });

  it('never upgrades a refused delivery, even if a receipt with the same keys exists', () => {
    const refused = deliverGate({ deliver: false });
    const receipt = event('hive.delivery', { note: 'note-1', to: 'worker' }, { run: 'run-1' });

    expect(judgeCards([refused, receipt])[0]).toMatchObject({ state: 'returned', action: 'denyDelivery' });
  });

  it('reports a publish verdict as permission only, and a gate fallback as withheld', () => {
    const publish = (overrides: Record<string, unknown>) =>
      judgeCards([
        event('hive.gate', gate({ gate: 'publish', bee: 'scout', text: 'Prefix is stable.', ...overrides }), {
          run: 'run-1',
        }),
      ])[0];

    expect(publish({ publish: true, kind: 'finding' })).toMatchObject({
      stage: 'publish',
      state: 'returned',
      action: 'allowPublish',
      preview: 'Prefix is stable.',
      route: { from: 'scout', to: '' },
    });
    expect(publish({ publish: false, kind: null })).toMatchObject({ action: 'denyPublish' });
    // The gate fails closed: a judge error withholds the note, and is never shown as "allowed".
    expect(publish({ publish: false, kind: null, score: 0, reason: 'error:timeout' })).toMatchObject({
      state: 'fallback',
      action: 'useDefault',
      outcome: { publish: false, score: 0 },
    });
    expect(publish({ publish: false, reason: 'shadow' })).toMatchObject({ state: 'shadow', action: 'observeOnly' });
  });

  it('keeps every gate a card of its own', () => {
    const cards = judgeCards([deliverGate(), deliverGate({ to: 'reviewer' }), deliverGate({ note: 'note-2' })]);

    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.evidence.length === 1 && !card.unlinked)).toBe(true);
  });
});

describe('JeV judgment cards: readable result and details', () => {
  const card = (payload: Record<string, unknown>) =>
    judgeCards([event('decision', payload, turn('runtime-a', 1, 5))])[0];

  it('labels scalar, list, ranked and per-candidate outcomes without inventing anything', () => {
    expect(resultFacts(card(ledger({ specId: 'turn.drift', outcome: 'on_track' })))).toEqual([
      { name: 'result', values: ['on_track'] },
    ]);
    expect(resultFacts(card(ledger({ specId: 'context.forget', outcome: ['keep', 'keep', 'shrink'] })))).toEqual([
      // A tally: the name is an answer the view labels as a value, not a field.
      { name: 'keep', values: ['×2'], tally: true },
      { name: 'shrink', values: ['×1'], tally: true },
    ]);
    expect(
      resultFacts(
        card(ledger({ specId: 'files.locate', outcome: { ranked: [{ path: 'src/a.ts', probability: 0.4 }] } }))
      )
    ).toEqual([{ name: 'path', values: ['src/a.ts'] }]);
    expect(
      resultFacts(
        card(
          ledger({ specId: 'swarm.routing', outcome: [{ strength: 0.606, thinking: 'high', agent: 'scout' }, null] })
        )
      )
    ).toEqual([
      {
        name: '1',
        values: [],
        pairs: [
          { key: 'strength', value: '0.61' },
          { key: 'thinking', value: 'high' },
          { key: 'agent', value: 'scout' },
        ],
      },
    ]);
    const hidden = Array.from({ length: 9 }, (_, index) => `skill-${index}`);
    expect(resultFacts(card(ledger({ specId: 'skills.disclosure', outcome: { hide: hidden, relevant: [] } })))).toEqual(
      [{ name: 'hide', values: hidden.slice(0, 6), more: 3 }]
    );
    expect(resultFacts(card(ledger({ specId: 'turn.drift', outcome: undefined })))).toEqual([]);
  });

  it('keeps the recorded probabilities for the details, ranked for a choice', () => {
    const { rows, more } = answerRows(
      card(
        ledger({
          answers: {
            turn_type: {
              type: 'choice',
              choice: 'research',
              probabilities: { chat: 0.02, research: 0.6, multi_step_task: 0.3, other: 0.08 },
            },
            is_side_question: { type: 'boolean', probability: 0.43 },
            task: { type: 'score', score: 1.91 },
            malformed: { type: 'boolean' },
          },
        })
      )
    );

    expect(more).toBe(0);
    expect(rows).toEqual([
      {
        id: 'turn_type',
        type: 'choice',
        choice: 'research',
        options: [
          { name: 'research', probability: 0.6 },
          { name: 'multi_step_task', probability: 0.3 },
          { name: 'other', probability: 0.08 },
        ],
      },
      { id: 'is_side_question', type: 'boolean', probability: 0.43 },
      { id: 'task', type: 'score', score: 1.91 },
    ]);
  });

  it('lists everything that is not a judgment as a runtime event, and nothing that another tab owns', () => {
    const kinds = runtimeEvents([
      event('agent_start', {}),
      event('progress', { step: 'choosing skills' }),
      event('decision', ledger({ specId: 'turn.drift' }), turn('runtime-a', 1, 5)),
      event('preflight.pending', {}, turn('runtime-a', 1, 2)),
      event('preflight.verdict', verdict()),
      event('hive.gate', gate({ gate: 'publish', publish: true }), { run: 'run-1' }),
      event('bee.event', {}, { run: 'run-1' }),
      event('swarm.snapshot', {}, { run: 'run-1' }),
      event('artifact.image', {}),
      event('memory.stored', {}),
    ]).map((record) => record.kind);

    expect(kinds).toEqual(['agent_start', 'progress', 'memory.stored']);
  });
});

describe('JeV judgment cards: what the view can translate', () => {
  it('knows every decision point of the harness, and has its question in each reference language', () => {
    // The spec ids of packages/kyrn-judge/src/decisions/*.ts in the harness repository.
    const harness = [
      'input.preflight',
      'input.interjection',
      'tool.admission',
      'context.forget',
      'context.compact',
      'skills.disclosure',
      'files.locate',
      'swarm.routing',
      'hive.publish',
      'hive.deliver',
      'browser.step',
      'memory.recall',
      'memory.capture',
      'tool.risk',
      'turn.drift',
      'turn.completion',
      'notify.routing',
      'cache.warming',
      'turn.rewind',
      'goal.met',
      'output.drift',
      'task.frame',
      'tool.constraint',
      'capability.disclosure',
      'diagnostics.delivery',
      'swarm.patch',
      'review.triage',
      'board.read',
    ];
    expect(harness.map(stageOf)).not.toContain('other');
    expect(stageOf('memory.future')).toBe('other');
    for (const locale of [common, zhCN, zhTW]) {
      const questions = locale.kyrn.judgeView.questions as Record<string, string>;
      for (const stage of [...Object.values(DECISIONS), 'other']) expect(questions[stage]).toBeTruthy();
    }
  });

  it('turns the preflight sentence for a wait without an answer into a code, and leaves codes alone', () => {
    expect(reasonCode('no answer after 6.0 s')).toBe('no_answer');
    expect(reasonCode('no answer after 12 s')).toBe('no_answer');
    expect(reasonCode('error:rate_limited')).toBe('error:rate_limited');
    expect(reasonCode('abstain')).toBe('abstain');
    expect(reasonCode('')).toBe('');
  });

  it('has a label for every judge error kind the harness reports', () => {
    const kinds = ['timeout', 'aborted', 'unreachable', 'auth', 'payment_required', 'rate_limited', 'bad_request'];
    for (const locale of [common, zhCN, zhTW]) {
      const values = locale.kyrn.judgeView.values as Record<string, string>;
      for (const kind of [...kinds, 'server', 'invalid_response', 'no_answer']) expect(values[kind]).toBeTruthy();
    }
  });
});
