import { describe, expect, it } from 'vitest';
import { parseHiveSnapshot, parseHiveTool } from '@/common/kyrn/hive';
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
});
