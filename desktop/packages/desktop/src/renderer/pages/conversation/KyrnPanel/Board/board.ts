import type { Activity } from '@/common/kyrn/types';
import { str } from '../activity';

/**
 * The plain-language board as the panel shows it, read from the harness's presentation events of one conversation:
 * `board.switched` ({ on, cwd }) says whether the board is on for the project, when the session opens and after
 * `/board on|off`; `board.update` is the latest board, `restored` when it is the last one replayed on opening.
 */

export const BOARD_PHASES = [
  'understanding',
  'planning',
  'changing',
  'checking',
  'fixing',
  'waiting',
  'wrapping_up',
  'stuck',
] as const;
export type BoardPhase = (typeof BOARD_PHASES)[number];

export type BoardUpdate = {
  /** The event's own id: a new one is a new board. */
  id: string;
  progress: string;
  now: string;
  confirm: string[];
  phase?: BoardPhase;
  needsUser: boolean;
  done: number;
  total: number;
  /** Written by the model, or the harness's fixed sentences when the model did not answer. */
  by: 'model' | 'rules';
  /** Written when the agent stopped. */
  ended: boolean;
  /** The last board, shown again as the session opened: not news. */
  restored: boolean;
  /** The text of the acceptance item being worked on (the task's own words), from a harness that sends it. */
  focusText?: string;
  /**
   * One per `confirm` line of a fixed board: `waiting_reply` for the harness's "It waits for your reply", null for a
   * line quoted from the agent. A harness that sends codes sends this with every fixed board, empty when nothing
   * waits: its presence says the board can be rebuilt from its facts.
   */
  confirmCodes?: (string | null)[];
};

export type BoardView = {
  /**
   * Whether this conversation's harness has a board at all: it said so (a switch or a board). Another agent's
   * conversation, or mu with the board feature off, never does, and `/board` would reach its model as a message.
   */
  known: boolean;
  /** Whether the board is on for this project; undefined until the session has said. */
  on: boolean | undefined;
  update?: BoardUpdate;
};

/** A line the board shows is short: a longer one is cut rather than let it take the panel. */
const LINE_LIMIT = 600;
const CONFIRM_LIMIT = 8;

const line = (value: unknown) => {
  const text = str(value).trim();
  return text.length > LINE_LIMIT ? `${text.slice(0, LINE_LIMIT)}…` : text;
};
/** A code is a lowercase word or words joined by underscores. */
const CODE = /^[a-z][a-z_]{0,47}$/;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

export function toBoardUpdate(event: Activity): BoardUpdate | undefined {
  const payload = event.payload;
  const now = line(payload.now);
  const progress = line(payload.progress);
  if (!now && !progress) return undefined;
  const phase = BOARD_PHASES.find((known) => known === payload.phase);
  // Each line keeps its code through the filtering: the codes are the lines' own, in the same order.
  const coded = Array.isArray(payload.confirmCodes);
  const codes: unknown[] = coded ? (payload.confirmCodes as unknown[]) : [];
  const confirmed = (Array.isArray(payload.confirm) ? payload.confirm : [])
    .map((item, index) => ({ text: line(item), code: CODE.test(str(codes[index])) ? str(codes[index]) : null }))
    .filter((item) => item.text)
    .slice(0, CONFIRM_LIMIT);
  const total = count(payload.total);
  const focusText = line(payload.focusText);
  return {
    id: event.id,
    progress,
    now,
    confirm: confirmed.map((item) => item.text),
    ...(coded ? { confirmCodes: confirmed.map((item) => item.code) } : {}),
    ...(focusText ? { focusText } : {}),
    ...(phase ? { phase } : {}),
    needsUser: payload.needsUser === true,
    done: Math.min(count(payload.done), total),
    total,
    by: payload.by === 'rules' ? 'rules' : 'model',
    ended: payload.ended === true,
    restored: payload.restored === true,
  };
}

/** What the board says now: the last switch and the last board, in the order the session sent them. */
export function boardView(events: readonly Activity[]): BoardView {
  let on: boolean | undefined;
  let update: BoardUpdate | undefined;
  for (const event of events) {
    if (event.kind === 'board.switched' && typeof event.payload.on === 'boolean') on = event.payload.on;
    else if (event.kind === 'board.update') {
      update = toBoardUpdate(event) ?? update;
      // A harness that sends boards has the board on, even when its switch was not seen.
      on ??= true;
    }
  }
  return { known: on !== undefined, on, ...(update ? { update } : {}) };
}

/** The part of the work done, from 0 to 1, when the task has acceptance items to count. */
export const share = (update: BoardUpdate) => (update.total > 0 ? update.done / update.total : undefined);

/** Whether the board asks something of the person: said so, or listed what to confirm. */
export const asksUser = (update: BoardUpdate) => update.needsUser || update.confirm.length > 0;

/** How many earlier boards the panel lists under the current one. */
const HISTORY_LIMIT = 5;

const sameWords = (a: BoardUpdate | undefined, b: BoardUpdate | undefined): boolean =>
  a !== undefined && b !== undefined && a.progress === b.progress && a.now === b.now;

/**
 * The boards before the current one, newest first, each with the time it came: what the board said as the work
 * went on. The one replayed as the session opens repeats an earlier board and is left out, and so is a board that
 * says the same as the one before it, or as the current one.
 */
export function boardHistory(
  events: readonly Activity[],
  current: BoardUpdate | undefined
): { at: number; update: BoardUpdate }[] {
  const earlier: { at: number; update: BoardUpdate }[] = [];
  for (const event of events) {
    if (event.kind !== 'board.update' || event.id === current?.id) continue;
    const update = toBoardUpdate(event);
    if (!update || update.restored || sameWords(earlier.at(-1)?.update, update)) continue;
    earlier.push({ at: event.at, update });
  }
  const shown = sameWords(earlier.at(-1)?.update, current) ? earlier.slice(0, -1) : earlier;
  return shown.slice(-HISTORY_LIMIT).toReversed();
}
