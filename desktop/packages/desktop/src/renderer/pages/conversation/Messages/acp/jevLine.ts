import type { TMessage } from '@/common/chat/chatLib';
import { readJevPreflightRow } from '@/renderer/utils/chat/jevPreflight';

/**
 * How Jev's classification of a message shows in the conversation: one line, not a tool call. The mu adapter
 * (`process/agent/kyrn/events.ts`) sends it as a tool call with the id `jev:<runtime>:<turn>` and marks its stage in
 * `rawOutput.preflight` (pending, verdict with the verdict's fields, fallback). Conversations recorded before that
 * carry only the English title ("JeV · Classifying", "JeV · <turn type>", "JeV · Fallback"), which is read instead.
 */
export type JevLine =
  | { stage: 'classifying' }
  /** A class it answered with; `state` as the harness names it (applied, shadow, late), `byRule` when no judge had to read it. */
  | { stage: 'classified'; turnType: string; state: string; byRule: boolean }
  /** No class this time: the turn goes on as it would without Jev. */
  | { stage: 'fallback' };

const JEV_ID = /^jev:/;

/**
 * The classes the harness's preflight answers with (`TurnType` of kyrn-judge's input preflight). Each has a name in
 * `common.kyrn.judgeView.values`; a class a newer harness adds is shown as "other" until it has one, never as its id.
 */
export const TURN_TYPES = [
  'chat',
  'chat_question',
  'quick_lookup',
  'single_edit',
  'multi_step_task',
  'research',
  'design_discussion',
] as const;
export type TurnType = (typeof TURN_TYPES)[number];

export const isTurnType = (value: string): value is TurnType => (TURN_TYPES as readonly string[]).includes(value);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export function jevLine(message: TMessage): JevLine | undefined {
  if (message.type !== 'acp_tool_call') return undefined;
  const update = record(message.content?.update);
  const id = str(update.tool_call_id) || str(update.toolCallId);
  if (!JEV_ID.test(id)) return undefined;
  if (update.status === 'pending' || update.status === 'in_progress') return { stage: 'classifying' };
  const raw = update.rawOutput ?? update.raw_output;
  const row = readJevPreflightRow(id, update.title, raw);
  if (row?.state === 'pending') return { stage: 'classifying' };
  const verdict = record(raw);
  const turnType = row?.state === 'verdict' ? (row.turnType ?? '') : '';
  const state = str(verdict.state) || 'applied';
  if (!turnType || turnType === 'unknown' || state === 'none') return { stage: 'fallback' };
  return { stage: 'classified', turnType, state, byRule: verdict.by === 'rule' };
}
