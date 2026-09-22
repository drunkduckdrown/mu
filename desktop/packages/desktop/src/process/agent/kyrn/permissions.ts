import type { PermissionOptionKind, SessionConfigOption, ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk';
import { array, asRecord, text, type JsonRecord } from './piRpc.ts';

/*
 * mu's permission modes in the app (the harness's kyrn/docs/features/permissions.md). The send box's permission
 * picker is an ACP `mode` option built from mu's `permissions.mode` event; picking a mode sends mu's own
 * `/permissions <id> --here`, which switches that conversation only (the mode new conversations start in is set in
 * the settings); mu's question before a call becomes a card whose buttons say what each answer does.
 */

export type PermissionModes = {
  /** The mode this conversation is in. */
  mode: string;
  /** Every mode, with its name and what it lets mu do, in the language mu speaks (MU_LANG). */
  modes: { id: string; label: string; description: string }[];
  /**
   * mu understands `/permissions <id> --here`, which switches this conversation only. An older mu would read
   * `--here` as an unknown word, so it only gets the plain command.
   */
  conversationSwitch: boolean;
};

/** What mu said just before it asks about a call: the picker that follows offers `answers`. */
export type PermissionRequest = {
  /** edit, shell, run, outside, delegate or other. */
  kind: string;
  /** The call: a command, `edit <path>`, `<tool> <target>`. */
  summary: string;
  answers: string[];
};

/** A presentation event mu sends on its status channel, or undefined for any other event. */
export function presentation(event: JsonRecord): { kind: string; payload: JsonRecord } | undefined {
  if (
    event.type !== 'extension_ui_request' ||
    event.method !== 'setStatus' ||
    event.statusKey !== 'kyrn.presentation.v1'
  )
    return undefined;
  try {
    const frame = asRecord(JSON.parse(text(event.statusText)));
    return typeof frame.kind === 'string' ? { kind: frame.kind, payload: asRecord(frame.payload) } : undefined;
  } catch {
    return undefined;
  }
}

/** Mode ids are words (`full`, `jev`, `ask`): anything else is not sent on as a command. */
const MODE_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const isModeId = (value: string): boolean => MODE_ID.test(value);

export function readModes(payload: JsonRecord): PermissionModes | undefined {
  const modes = array(payload.modes)
    .map(asRecord)
    .map((mode) => ({
      id: text(mode.id),
      label: text(mode.label) || text(mode.id),
      description: text(mode.description),
    }))
    .filter((mode) => MODE_ID.test(mode.id));
  const mode = text(payload.mode);
  return modes.some((each) => each.id === mode)
    ? { mode, modes, conversationSwitch: payload.conversationSwitch === true }
    : undefined;
}

export function readRequest(payload: JsonRecord): PermissionRequest | undefined {
  const answers = array(payload.answers).map(text);
  if (answers.length < 2 || answers.some((answer) => !answer)) return undefined;
  return { kind: text(payload.kind), summary: text(payload.summary), answers };
}

/** The send box's permission picker. The category is what the app looks for; the names are mu's. */
export const modeOption = ({ mode, modes }: PermissionModes): SessionConfigOption => ({
  id: 'mode',
  category: 'mode',
  name: 'Permissions',
  type: 'select',
  currentValue: mode,
  options: modes.map((each) => ({
    value: each.id,
    name: each.label,
    ...(each.description ? { description: each.description } : {}),
  })),
});

/** Whether a picker offers exactly what mu said it would ask. */
export const asks = (request: PermissionRequest, choices: string[]): boolean =>
  request.answers.length === choices.length && request.answers.every((answer, i) => answer === choices[i]);

const TOOL_KIND: Record<string, ToolKind> = { edit: 'edit', outside: 'edit', shell: 'execute', run: 'execute' };

/**
 * mu's picker as the call a permission card shows. The picker's title is three lines: what mu wants to do, the call,
 * and why it asks. The card gets the first as its title, the reason under it and the call where a command goes. The
 * call is taken from the request, not the title, because a command can itself run over several lines.
 */
export function permissionCall(request: PermissionRequest, title: string): Omit<ToolCallUpdate, 'toolCallId'> {
  const lines = title.split('\n');
  const why = lines.length > 2 ? (lines.at(-1) ?? '').trim() : '';
  return {
    title: lines[0] || request.summary,
    kind: TOOL_KIND[request.kind] ?? 'other',
    rawInput: { command: request.summary, ...(why ? { description: why } : {}) },
    content: [{ type: 'content', content: { type: 'text', text: title } }],
  };
}

/** mu's answers are "once", then "for this conversation" when offered, then "don't allow". */
export function answerKind(index: number, count: number): PermissionOptionKind {
  if (index === count - 1) return 'reject_once';
  return index === 0 ? 'allow_once' : 'allow_always';
}
