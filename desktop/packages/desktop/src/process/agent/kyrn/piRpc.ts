import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { muEnv, muHome } from './naming.ts';
import { wslLaunch, wslLocation } from './wsl.ts';

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

/**
 * How the launcher is started. A Node launcher (`kyrn/bin/mu.mjs`, what Windows and the npm package use) runs with
 * this process's own Node, or `MU_NODE`: no shell and no `.cmd`, which Node refuses to spawn without one. Anything
 * else is an executable (the bash forwarder of a checkout).
 */
export function launchCommand(
  launcher: string,
  args: string[],
  node: string = process.env.MU_NODE || process.execPath
): { command: string; args: string[] } {
  return /\.[cm]?js$/i.test(launcher) ? { command: node, args: [launcher, ...args] } : { command: launcher, args };
}

/**
 * Ends the harness and everything it started (tools, MCP servers, language servers). POSIX: the process group it
 * leads. Windows has no groups: `taskkill /T` walks the tree, and `/F` because a console-less child cannot be asked.
 */
export function endTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
  run: {
    group: (pid: number, signal: NodeJS.Signals) => void;
    taskkill: (args: string[]) => void;
    own: (signal: NodeJS.Signals) => void;
  }
): void {
  if (!pid) return run.own(signal);
  if (platform === 'win32') return run.taskkill(['/pid', String(pid), '/T', '/F']);
  run.group(pid, signal);
}

/** Owns the pi process; stdout is protocol-only and stderr never reaches the client. */
export class PiRpc implements RpcPort {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve(value: JsonRecord): void; reject(error: Error): void; timer?: NodeJS.Timeout }
  >();
  private closed = false;
  /** Runs inside WSL, through wsl.exe (see wsl.ts). */
  private wsl: boolean;
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
    // A project inside WSL gets its harness inside WSL (Windows only).
    const location = process.platform === 'win32' ? wslLocation(cwd) : undefined;
    this.wsl = location !== undefined;
    const start = location
      ? wslLaunch({
          location,
          session,
          env: env ?? {},
          agentDir: muEnv('AGENT_DIR') || join(muHome(), 'agent'),
          inherited: process.env.WSLENV,
          home: homedir(),
        })
      : {
          ...launchCommand(launcher, ['--mode', 'rpc', ...(session ? ['--session', session] : [])]),
          cwd,
          env: env ?? {},
        };
    this.child = spawn(start.command, start.args, {
      cwd: start.cwd,
      env: { ...process.env, ...start.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      // No console window flashing up on Windows for a process that only speaks JSON lines.
      windowsHide: true,
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
        endTree(pid, signal, process.platform, {
          group: (leader, sent) => process.kill(-leader, sent),
          taskkill: (args) => {
            spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).on('error', () => this.child.kill());
          },
          own: (sent) => this.child.kill(sent),
        });
      } catch {}
    };
    const end = () => {
      kill('SIGTERM');
      const timer = setTimeout(() => kill('SIGKILL'), 3000);
      timer.unref();
      this.child.once('exit', () => clearTimeout(timer));
    };
    if (this.wsl) {
      // Ending wsl.exe does not reach everything it started inside Linux. mu ends itself when its input ends; the
      // tree is ended only if it has not by then.
      this.child.stdin.end();
      const timer = setTimeout(end, 2000);
      timer.unref();
      this.child.once('exit', () => clearTimeout(timer));
    } else end();
    this.finish(new Error('mu session closed'));
  }
}
