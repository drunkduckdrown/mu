import { describe, it, expect } from 'vitest';
import { mapEvent } from '../../../packages/desktop/src/process/agent/kyrn/events.ts';

describe('KYRN events in native AionUi cards', () => {
  it('updates one classification card and never invents reasoning tokens', () => {
    const frame = (kind: string, payload: object) =>
      mapEvent({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'kyrn.presentation.v1',
        statusText: JSON.stringify({ runtimeId: 'r', turnId: 1, kind, payload }),
      });
    expect(frame('preflight.pending', {})[0]).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'jev:r:1',
      title: 'Jev · Classifying',
      status: 'in_progress',
      rawOutput: { preflight: 'pending' },
    });
    expect(frame('preflight.verdict', { turnType: 'chat' })[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'jev:r:1',
      title: 'Jev · chat',
      status: 'completed',
      rawOutput: { turnType: 'chat', preflight: 'verdict' },
    });
    expect(frame('preflight.verdict', {})[0]).toMatchObject({
      title: 'Jev · Default',
      rawOutput: { preflight: 'verdict' },
    });
    expect(frame('preflight.wait_end', { reason: 'timeout' })[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'jev:r:1',
      title: 'Jev · Fallback',
      status: 'completed',
      rawOutput: { preflight: 'fallback' },
    });
    // The verdict's own JSON stays the row's output, without the desktop's marker.
    const verdict = frame('preflight.verdict', { turnType: 'chat' })[0];
    expect(verdict.sessionUpdate === 'tool_call_update' && verdict.content?.[0]).toMatchObject({
      content: { text: JSON.stringify({ turnType: 'chat' }, null, 2) },
    });
    expect(
      mapEvent({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'kyrn.presentation.v1',
        statusText: 'invalid',
      })
    ).toEqual([]);
  });
  it('preserves intermediate hive results and failed tool status', () => {
    expect(
      mapEvent({
        type: 'tool_execution_update',
        toolCallId: 'hive1',
        partialResult: { content: [{ type: 'text', text: 'investigator: reading' }] },
      })[0]
    ).toMatchObject({ status: 'in_progress', rawOutput: { content: [{ text: 'investigator: reading' }] } });
    expect(mapEvent({ type: 'tool_execution_end', toolCallId: 'hive1', isError: true, result: {} })[0]).toMatchObject({
      status: 'failed',
    });
    expect(
      mapEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Provider reasoning summary' },
      })
    ).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Provider reasoning summary' } },
    ]);
  });
});
