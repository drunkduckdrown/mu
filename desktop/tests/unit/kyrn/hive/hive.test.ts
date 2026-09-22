import { describe, expect, it } from 'vitest';
import {
  parseBeeActivity,
  parseHiveSnapshot,
  parseHiveTool,
  parseSwarmProgress,
  parseSwarmSnapshot,
} from '@/common/kyrn/hive';
import { normalizeAcpToolCall } from '@/common/chat/normalizeToolCall';
import { buildHiveRuns, beeRecords } from '@/renderer/pages/conversation/KyrnPanel/Hive/activity';
import { mergeActivity } from '@/renderer/pages/conversation/KyrnPanel/activity';
import { activity, hiveEvents, hiveMessage, hiveSnapshot } from './hiveFixtures';

describe('Native Hive event projection', () => {
  it('ignores delegate and malformed snapshots instead of manufacturing bee state', () => {
    expect(parseHiveSnapshot({ kind: 'delegate', bees: [] })).toBeUndefined();
    expect(parseHiveSnapshot({ kind: 'hive', bees: null })).toBeUndefined();
    expect(
      parseHiveSnapshot({ kind: 'hive', bees: [null, {}, { name: 'a', status: 'future', turns: NaN }, { name: 'a' }] })
        ?.bees
    ).toMatchObject([{ name: 'a', status: 'unknown', turns: 0 }]);
  });

  it('retains structured Hive state and original raw evidence during ACP normalization', () => {
    const normalized = normalizeAcpToolCall(hiveMessage());
    expect(normalized?.hive?.names).toEqual(['prefix-mutations', 'provider-cache']);
    expect(normalized?.output).toBe('\u001b[32mOriginal terminal evidence\u001b[0m');
    expect(normalized?.key).toBe('run-1');
  });

  it('supports a named Hive before its first snapshot but not unrelated tool titles', () => {
    expect(parseHiveTool('hive', { bees: [{ name: 'a' }] }, undefined)).toMatchObject({
      names: ['a'],
      snapshot: undefined,
    });
    expect(parseHiveTool('archive-hive', {}, {})).toBeUndefined();
    expect(parseHiveTool('other', {}, { details: { snapshot: hiveSnapshot } })?.snapshot?.bees).toHaveLength(2);
  });

  it('never turns a passed gate into a confirmed delivery', () => {
    const runs = buildHiveRuns(hiveEvents.filter((event) => event.kind !== 'hive.delivery'));
    expect(runs[0].gates).toHaveLength(1);
    expect(runs[0].deliveries).toEqual([]);
  });

  it('joins and deduplicates deliveries within the exact run', () => {
    const events = [
      ...hiveEvents,
      activity('snapshot-other', 'swarm.snapshot', hiveSnapshot, 'run-2'),
      activity('receipt-other', 'hive.delivery', { note: 'note-1', to: 'provider-cache' }, 'run-2'),
      activity('receipt-repeat', 'hive.delivery', { note: 'note-1', to: 'provider-cache' }),
    ];
    const runs = buildHiveRuns(events);
    expect(runs.find((run) => run.id === 'run-1')?.deliveries).toMatchObject([
      { from: 'prefix-mutations', to: 'provider-cache' },
    ]);
    expect(runs.find((run) => run.id === 'run-2')?.deliveries).toMatchObject([{ from: '', text: '' }]);
  });

  it('keeps real execution records after a final compact snapshot clears live text', () => {
    const final = {
      ...hiveSnapshot,
      endedAt: 9000,
      bees: hiveSnapshot.bees.map((bee) => ({ ...bee, status: 'done', said: '', recent: [], finals: [] })),
    };
    const run = buildHiveRuns(mergeActivity(hiveEvents, [activity('final', 'swarm.snapshot', final)]))[0];
    expect(run.snapshot?.bees.every((bee) => bee.status === 'done')).toBe(true);
    expect(beeRecords(run.events, 'provider-cache')).toMatchObject([
      { kind: 'assistant', text: 'Confirmed stable prefix.' },
    ]);
    expect(run.assignments[1].focus).toBe('Inspect provider mapping');
  });

  it('pairs tool start/output and avoids duplicating the matching toolResult message', () => {
    const events = [
      ...hiveEvents,
      activity(
        'tool-message',
        'bee.event',
        {
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: 'read-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'export const stablePrefix = true;' }],
          },
        },
        'run-1',
        'prefix-mutations'
      ),
    ];
    expect(beeRecords(events, 'prefix-mutations')).toMatchObject([
      { kind: 'tool', name: 'read', complete: true, text: 'export const stablePrefix = true;' },
    ]);
    expect(beeRecords(events, 'prefix-mutations')).toHaveLength(1);
  });

  it('never renders signatures, images, or guessed thinking as transcript text', () => {
    const events = [
      activity(
        'thinking',
        'bee.event',
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Public reasoning', thinkingSignature: 'private-signature' },
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'image', data: 'binary' },
            ],
          },
        },
        'run-1',
        'a'
      ),
    ];
    expect(beeRecords(events, 'a')).toMatchObject([{ kind: 'thinking', text: 'Public reasoning' }]);
    expect(JSON.stringify(beeRecords(events, 'a'))).not.toContain('private-signature');
    expect(beeRecords(events, 'missing')).toEqual([]);
  });

  it('does not shift assignments when an invalid snapshot row is skipped', () => {
    const snapshot = parseHiveSnapshot({ kind: 'hive', bees: [null, { name: 'second', status: 'done' }] });
    expect(snapshot?.bees[0].assignmentIndex).toBe(1);
  });

  it('does not infer assignments when an old run has no recorded manifest', () => {
    expect(buildHiveRuns(hiveEvents.filter((event) => event.kind !== 'hive.manifest'))[0].assignments).toEqual([]);
    expect(buildHiveRuns([activity('delegate', 'swarm.snapshot', { ...hiveSnapshot, kind: 'delegate' })])).toEqual([]);
  });

  it('keeps the codes beside the English of a snapshot, typed, for translation at render time', () => {
    const snapshot = parseSwarmSnapshot({
      kind: 'delegate',
      title: '2 tasks',
      titleCode: { code: 'delegate_tasks', params: { count: 2, junk: { nested: true } } },
      bees: [
        {
          name: 'scan',
          status: 'timed-out',
          error: 'time budget of 10 min reached; no report within 90s of being asked',
          errorCode: 'no_report_in_time',
          errorParams: { seconds: 90, after: 'time_budget' },
          wrapUp: { at: 5, reason: 'time budget of 10 min reached', code: 'time_budget', params: { minutes: 10 } },
          recent: [
            { at: 3, text: '← 2 notes from the others', code: 'notes_received', params: { count: 2 } },
            { at: 4, text: 'bash npm test' },
            null,
            { at: 5 },
          ],
        },
        { name: 'fix', status: 'queued' },
      ],
    });
    expect(snapshot).toMatchObject({
      kind: 'delegate',
      title: '2 tasks',
      titleCode: { code: 'delegate_tasks', params: { count: 2 } },
    });
    expect(snapshot?.titleCode?.params).not.toHaveProperty('junk');
    expect(snapshot?.bees[0]).toMatchObject({
      errorCode: 'no_report_in_time',
      errorParams: { seconds: 90, after: 'time_budget' },
      wrapUp: { reason: 'time budget of 10 min reached', code: 'time_budget', params: { minutes: 10 } },
      recent: [
        { at: 3, text: '← 2 notes from the others', code: 'notes_received', params: { count: 2 } },
        { at: 4, text: 'bash npm test', params: {} },
      ],
    });
    // An older snapshot carries no codes: the fields are simply absent.
    expect(snapshot?.bees[1]).toMatchObject({ error: '', errorParams: {}, recent: [] });
    expect(snapshot?.bees[1].errorCode).toBeUndefined();
    expect(snapshot?.bees[1].wrapUp).toBeUndefined();
    expect(parseSwarmSnapshot({ kind: 'future', bees: [] })).toBeUndefined();
    expect(parseHiveSnapshot({ ...hiveSnapshot, titleCode: { code: 'x' } })?.titleCode).toEqual({
      code: 'x',
      params: {},
    });
    expect(parseBeeActivity('not a list')).toEqual([]);
  });

  it('reads the routing step before the first snapshot, and nothing once there is one', () => {
    const choosing = { details: { code: 'choosing_roles', params: { count: 3 } } };
    expect(parseSwarmProgress(choosing)).toEqual({ code: 'choosing_roles', params: { count: 3 } });
    expect(parseSwarmProgress({ details: { snapshot: hiveSnapshot } })).toBeUndefined();
    expect(parseSwarmProgress({ details: { code: 'done' } })).toBeUndefined();
    expect(parseSwarmProgress(undefined)).toBeUndefined();
    const message = hiveMessage();
    message.content.update.title = 'delegate';
    message.content.update.rawOutput = choosing;
    const normalized = normalizeAcpToolCall(message);
    expect(normalized?.swarmProgress).toEqual({ code: 'choosing_roles', params: { count: 3 } });
    expect(normalized?.hive).toBeUndefined();
    // The English output stays the raw evidence it was.
    expect(normalized?.output).toBe('\u001b[32mOriginal terminal evidence\u001b[0m');
  });
});
