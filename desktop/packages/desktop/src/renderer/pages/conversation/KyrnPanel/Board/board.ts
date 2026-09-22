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
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

export function toBoardUpdate(event: Activity): BoardUpdate | undefined {
  const payload = event.payload;
  const now = line(payload.now);
  const progress = line(payload.progress);
  if (!now && !progress) return undefined;
  const phase = BOARD_PHASES.find((known) => known === payload.phase);
  const confirm = (Array.isArray(payload.confirm) ? payload.confirm : []).map(line).filter(Boolean);
  const total = count(payload.total);
  return {
    id: event.id,
    progress,
    now,
    confirm: confirm.slice(0, CONFIRM_LIMIT),
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
