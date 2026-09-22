import { appendFileSync, closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Activity, ActivityPage } from '../../../common/kyrn/types';
import { array, asRecord, text, type JsonRecord } from './piRpc';

const MAX_PAGE = 16 * 1024 * 1024;
export function readPage(path: string, cursor: number): { rows: JsonRecord[]; cursor: number; more: boolean } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], cursor: 0, more: false };
    throw e;
  }
  try {
    const size = statSync(path).size;
    const start = cursor > size ? 0 : cursor;
    const buffer = Buffer.alloc(Math.min(MAX_PAGE, Math.max(0, size - start)));
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const end = buffer.subarray(0, bytes).lastIndexOf(10) + 1;
    if (!end && bytes === MAX_PAGE) throw new Error('Activity record exceeds the page limit');
    const rows = buffer
      .subarray(0, end)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [asRecord(JSON.parse(line))];
        } catch {
          return [];
        }
      });
    return { rows, cursor: start + end, more: start + end < size && end > 0 };
  } finally {
    closeSync(fd);
  }
}

export function activityPage(store: string, sessionId: string, cursor: number): ActivityPage {
  if (!/^[a-f\d-]{36}$/.test(sessionId) || !Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error('Invalid activity cursor');
  const page = readPage(join(store, `${sessionId}.events.jsonl`), cursor);
  return { sessionId, cursor: page.cursor, more: page.more, events: page.rows as Activity[] };
}

/** One durable, presentation-only stream. It is never appended to the model context. */
export class Telemetry {
  private path: string;
  private offsets = new Map<string, number>();
  private lastContext = '';
  constructor(store: string, sessionId: string) {
    this.path = join(store, `${sessionId}.events.jsonl`);
  }
  private append(
    kind: string,
    payload: JsonRecord,
    run?: string,
    bee?: string,
    correlation?: Pick<Activity, 'runtimeId' | 'turnId' | 'sequence'>
  ): void {
    const event: Activity = { id: randomUUID(), at: Date.now(), kind, payload, run, bee, ...correlation };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
  context(state: JsonRecord): void {
    // Only presentation data; never persist credentials, full settings or prompts.
    const payload = {
      usage: asRecord(state.contextUsage),
      settings: asRecord(state.compactionSettings),
      sessionTokens: asRecord(state.sessionTokens),
      model: text(asRecord(state.model).id),
      busy: state.isStreaming === true,
      compacting: state.isCompacting === true,
    };
    const key = JSON.stringify(payload);
    if (key === this.lastContext) return;
    try {
      this.append('context.usage', payload);
      this.lastContext = key;
    } catch {
      /* Observability cannot fail a turn. */
    }
  }
  private ingest(path: string, kind: string, run: string, bee?: string): void {
    try {
      if (dirname(realpathSync(path)) !== realpathSync(dirname(path))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let more: boolean;
    do {
      const page = readPage(path, this.offsets.get(path) ?? 0);
      this.offsets.set(path, page.cursor);
      more = page.more;
      for (const row of page.rows) {
        this.append(kind, row, run, bee);
        const message = asRecord(row.message);
        if (row.type === 'message_end' && message.role === 'toolResult') this.images(message.content, run, bee);
      }
    } while (more);
  }
  private images(content: unknown, run: string, bee?: string): void {
    for (const block of array(content).map(asRecord)) {
      if (
        block.type === 'image' &&
        /^image\/(png|jpeg|webp|gif)$/.test(text(block.mimeType)) &&
        text(block.data).length < 8 * 1024 * 1024
      )
        this.append(
          'artifact.image',
          { type: 'image', data: block.data, mimeType: block.mimeType, toolCallId: run },
          run,
          bee
        );
    }
  }
  capture(event: JsonRecord): void {
    try {
      if (
        event.type === 'extension_ui_request' &&
        event.method === 'setStatus' &&
        event.statusKey === 'kyrn.presentation.v1'
      ) {
        const frame = asRecord(JSON.parse(text(event.statusText)));
        if (frame.version === 1 && typeof frame.kind === 'string') {
          const correlation =
            typeof frame.runtimeId === 'string' &&
            frame.runtimeId &&
            Number.isSafeInteger(frame.turnId) &&
            Number(frame.turnId) >= 0 &&
            Number.isSafeInteger(frame.sequence) &&
            Number(frame.sequence) > 0
              ? { runtimeId: frame.runtimeId, turnId: Number(frame.turnId), sequence: Number(frame.sequence) }
              : undefined;
          this.append(frame.kind, asRecord(frame.payload), undefined, undefined, correlation);
        }
      }
      if (['agent_start', 'agent_settled', 'kyrn_rpc_closed'].includes(text(event.type)))
        this.append(text(event.type), {});
      if (event.type === 'compaction_start') this.append('compaction_start', { reason: event.reason });
      if (event.type === 'compaction_end') {
        const result = asRecord(event.result);
        this.append('compaction_end', {
          reason: event.reason,
          aborted: event.aborted,
          error: event.errorMessage,
          applied: Boolean(event.result) && !event.aborted,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.estimatedTokensAfter,
          beta: asRecord(asRecord(result.details).kyrn).version === 1,
          metrics: asRecord(asRecord(result.details).kyrn).metrics,
        });
      }
      if (event.type === 'message_end') {
        const message = asRecord(event.message);
        if (message.customType === 'kyrn.lessons') this.append('memory.recalled', { content: message.content });
      }
      if (event.type === 'tool_execution_start' && event.toolName === 'hive') {
        const run = text(event.toolCallId);
        const args = asRecord(event.args);
        if (run.trim() && typeof args.goal === 'string' && Array.isArray(args.bees))
          this.append(
            'hive.manifest',
            {
              goal: args.goal.slice(0, 16000),
              bees: args.bees.slice(0, 16).map((bee) => {
                const row = asRecord(bee);
                return { name: text(row.name).slice(0, 160), focus: text(row.focus).slice(0, 16000) };
              }),
            },
            run
          );
      }
      if (!['tool_execution_update', 'tool_execution_end'].includes(text(event.type))) return;
      const result = asRecord(event.result ?? event.partialResult);
      const snapshot = asRecord(asRecord(result.details).snapshot);
      const run = text(event.toolCallId);
      if (['hive', 'delegate'].includes(text(snapshot.kind))) {
        this.append('swarm.snapshot', snapshot, run);
        // Only known mu temp run directories (still named kyrn-*) are eligible; never follow a tool-supplied arbitrary path.
        const dir = realpathSync(text(snapshot.dir));
        if (dirname(dir) !== realpathSync(tmpdir()) || !/^kyrn-(hive|swarm|delegate)-[\w-]+$/.test(basename(dir)))
          return;
        for (const [name, kind] of [
          ['board.jsonl', 'hive.note'],
          ['deliveries.jsonl', 'hive.delivery'],
          ['gate.jsonl', 'hive.gate'],
        ])
          this.ingest(join(dir, name), kind, run);
        for (const bee of array(snapshot.bees).map(asRecord)) {
          if (!bee.transcript) continue;
          try {
            const path = realpathSync(text(bee.transcript));
            if (dirname(path) === join(dir, 'transcripts')) this.ingest(path, 'bee.event', run, text(bee.name));
          } catch {
            /* A queued bee has no transcript yet; keep reading the other bees. */
          }
        }
      }
      if (event.type === 'tool_execution_end') this.images(result.content, run);
    } catch {
      /* Observability must never block or fail a model turn. */
    }
  }
}
