/**
 * What the app shows about one judge-driven browsing run, per browser tab.
 *
 * The main process owns the truth (it answers the harness); the renderer keeps a
 * mirror built from the same events with the same reducer, so both sides agree
 * by construction. Everything that comes from a web page (`action`, `label`,
 * `url`, `detail`) is untrusted text: it is shown as plain text and nothing else.
 */

/** The session partition of agent-driven tabs: apart from the app and from the manual preview browser. */
export const MU_BROWSER_PARTITION = 'persist:mu-browser';

/** How long the person has to answer a confirmation before it counts as a refusal. */
export const CONFIRM_TIMEOUT_MS = 120_000;

const MAX_STEPS_KEPT = 200;
const MAX_NOTICES_KEPT = 20;
const MAX_TEXT = 300;

/**
 * `done` … `budget` are the harness's own results (`aborted` is shown as `stopped`).
 * `ended` means the harness closed the run without saying how it went; `detached`
 * means the page was taken away from it (tab closed, DevTools opened, connection lost).
 */
export type BrowserRunStatus =
  | 'done'
  | 'blocked'
  | 'needs_confirmation'
  | 'stopped'
  | 'budget'
  | 'read'
  | 'failed'
  | 'ended'
  | 'detached';

/** Why a run is paused: the pause button, the take-over button, or the person touching the page. */
export type PauseReason = 'user' | 'takeover' | 'interaction';

export type BrowserRunStep = {
  step: number;
  kind: string;
  action: string;
  url: string;
  probability?: number;
  pageChanged?: boolean;
  at: number;
};

export type BrowserRunConfirm = {
  id: string;
  label: string;
  url: string;
  askedAt: number;
  deadline: number;
};

export type BrowserRunNoticeKind = 'download' | 'permission' | 'navigation' | 'popup';

export type BrowserRunNotice = {
  kind: BrowserRunNoticeKind;
  detail: string;
  at: number;
};

export type BrowserRunState = {
  tabId: string;
  conversationId: string;
  phase: 'running' | 'finished';
  goal: string;
  startUrl: string;
  startedAt: number;
  finishedAt?: number;
  paused: boolean;
  pausedBy?: PauseReason;
  stopRequested: boolean;
  steps: BrowserRunStep[];
  confirm?: BrowserRunConfirm;
  notices: BrowserRunNotice[];
  status?: BrowserRunStatus;
  reason?: string;
};

export type BrowserRunEvent =
  | { type: 'started'; tabId: string; conversationId: string; url: string; at: number }
  | { type: 'goal'; tabId: string; goal: string; url?: string }
  | { type: 'step'; tabId: string; step: BrowserRunStep }
  | { type: 'control'; tabId: string; paused: boolean; pausedBy?: PauseReason; stopRequested: boolean }
  | { type: 'confirm'; tabId: string; confirm: BrowserRunConfirm }
  | { type: 'confirmed'; tabId: string; id: string; allowed: boolean }
  | { type: 'notice'; tabId: string; notice: BrowserRunNotice }
  | { type: 'finished'; tabId: string; status: BrowserRunStatus; reason?: string; at: number }
  | { type: 'closed'; tabId: string }
  | { type: 'snapshot'; runs: BrowserRunState[] };

export type BrowserRuns = Readonly<Record<string, BrowserRunState>>;

/** What the person can ask of a run from the step bar. */
export type BrowserControlAction = 'pause' | 'resume' | 'stop' | 'takeover';

/** C0 and C1 control characters and the two Unicode line separators: none of them belongs in one line of text. */
const isControl = (code: number): boolean =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

/** Page text becomes one bounded line of plain text before it is kept or shown. */
export function plainText(value: unknown, limit: number = MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  let line = '';
  // A page can hand over megabytes; nothing past a few times the limit can survive the cut below.
  for (const character of value.slice(0, limit * 4)) {
    line += isControl(character.codePointAt(0) ?? 0) ? ' ' : character;
  }
  const cleaned = line.replace(/\s+/g, ' ').trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

function change(
  runs: BrowserRuns,
  tabId: string,
  update: (run: BrowserRunState) => BrowserRunState | undefined
): BrowserRuns {
  const run = runs[tabId];
  if (!run) return runs;
  const next = update(run);
  return next && next !== run ? { ...runs, [tabId]: next } : runs;
}

export function reduceBrowserRuns(runs: BrowserRuns, event: BrowserRunEvent): BrowserRuns {
  switch (event.type) {
    case 'snapshot':
      return Object.fromEntries(event.runs.map((run) => [run.tabId, run]));
    case 'started':
      // A reused tab starts from nothing: no step, pause or verdict of the run before it survives.
      return {
        ...runs,
        [event.tabId]: {
          tabId: event.tabId,
          conversationId: event.conversationId,
          phase: 'running',
          goal: '',
          startUrl: event.url,
          startedAt: event.at,
          paused: false,
          stopRequested: false,
          steps: [],
          notices: [],
        },
      };
    case 'closed': {
      if (!runs[event.tabId]) return runs;
      const { [event.tabId]: _closed, ...rest } = runs;
      return rest;
    }
    case 'goal':
      return change(runs, event.tabId, (run) => ({
        ...run,
        goal: plainText(event.goal, 600),
        startUrl: event.url || run.startUrl,
      }));
    case 'step':
      return change(runs, event.tabId, (run) =>
        run.phase === 'finished' ? undefined : { ...run, steps: [...run.steps, event.step].slice(-MAX_STEPS_KEPT) }
      );
    case 'control':
      return change(runs, event.tabId, (run) =>
        run.phase === 'finished'
          ? undefined
          : {
              ...run,
              paused: event.paused,
              pausedBy: event.paused ? event.pausedBy : undefined,
              stopRequested: event.stopRequested,
            }
      );
    case 'confirm':
      return change(runs, event.tabId, (run) =>
        run.phase === 'finished' ? undefined : { ...run, confirm: event.confirm }
      );
    case 'confirmed':
      return change(runs, event.tabId, (run) =>
        run.confirm?.id === event.id ? { ...run, confirm: undefined } : undefined
      );
    case 'notice':
      return change(runs, event.tabId, (run) => ({
        ...run,
        notices: [...run.notices, event.notice].slice(-MAX_NOTICES_KEPT),
      }));
    case 'finished':
      return change(runs, event.tabId, (run) =>
        run.phase === 'finished'
          ? undefined
          : {
              ...run,
              phase: 'finished',
              status: event.status,
              reason: event.reason ? plainText(event.reason, 600) : undefined,
              finishedAt: event.at,
              paused: false,
              pausedBy: undefined,
              confirm: undefined,
            }
      );
  }
}

/** The runs of one conversation, latest first. */
export function runsOfConversation(runs: BrowserRuns, conversationId: string): BrowserRunState[] {
  return Object.values(runs)
    .filter((run) => run.conversationId === conversationId)
    .toSorted((a, b) => b.startedAt - a.startedAt);
}
