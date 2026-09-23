import { describe, expect, it } from 'vitest';
import type { Activity } from '@/common/kyrn/types';
import { logItems } from '@/renderer/pages/conversation/KyrnPanel/Judge/log';

let sequence = 0;
const event = (kind: string, payload: Record<string, unknown> = {}): Activity => ({
  id: `${kind}:${++sequence}`,
  at: sequence,
  kind,
  payload,
  runtimeId: 'runtime',
  sequence,
});

describe('the judge log', () => {
  it('leaves the board to the board tab: neither its boards nor the lines of its account are listed', () => {
    const items = logItems([
      event('board.update', { now: 'Changing the code.', progress: 'Halfway.' }),
      event('board.note', { sequence: 1, at: 1, kind: 'step', text: 'Changed src/a.ts', by: 'rules' }),
      event('goal.state', { status: 'active' }),
    ]);
    expect(items.map((item) => (item.type === 'event' ? item.event.kind : item.type))).toEqual(['goal.state']);
  });
});
