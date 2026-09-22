import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export type JsonRecord = Record<string, unknown>;
export const asRecord = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export interface RpcPort {
  send(command: JsonRecord): Promise<JsonRecord>;
  respond(response: JsonRecord): void;
  close(): void;
}

/** Owns the pi process; stdout is protocol-only and stderr never reaches the client. */
export class PiRpc implements RpcPort {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve(value: JsonRecord): void; reject(error: Error): void; timer?: NodeJS.Timeout }
  >();
  private closed = false;
  private onEvent: (event: JsonRecord) => void;
  constructor(
    launcher: string,
    cwd: string,
    session: string | undefined,
    onEvent: (event: JsonRecord) => void,
    /** Added to the inherited environment of the harness process. */
    env?: Readonly<Record<string, string>>
  ) {
    this.onEvent = onEvent;
    this.child = spawn(launcher, ['--mode', 'rpc', ...(session ? ['--session', session] : [])], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let event: JsonRecord;
      try {
        event = asRecord(JSON.parse(line));
      } catch {
        return;
      }
      const request = this.pending.get(text(event.id));
      if (event.type === 'response' && request) {
        this.pending.delete(text(event.id));
        clearTimeout(request.timer);
        if (event.success) request.resolve(asRecord(event.data));
        else request.reject(new Error(text(event.error) || 'mu RPC command failed'));
      }
      onEvent(event);
    });
    this.child.on('error', () => this.finish(new Error('mu failed to start')));
    this.child.on('exit', () => this.finish(new Error('mu process exited')));
  }
  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.onEvent({ type: 'kyrn_rpc_closed' });
  }
  send(command: JsonRecord): Promise<JsonRecord> {
    if (this.closed) return Promise.reject(new Error('mu process is closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      // A difficult prompt can run for hours. Only control commands have a deadline.
      const timer =
        command.type === 'prompt'
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error('mu control command timed out'));
            }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  respond(response: JsonRecord): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ ...response, type: 'extension_ui_response' })}\n`);
  }
  close(): void {
    if (this.closed) return;
    const pid = this.child.pid;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (pid && process.platform !== 'win32') process.kill(-pid, signal);
        else this.child.kill(signal);
      } catch {}
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 3000);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
    this.finish(new Error('mu session closed'));
  }
}
