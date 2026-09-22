import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findTsx,
  LoginManager,
  openable,
  type RunnerProcess,
} from '../../../../packages/desktop/src/process/agent/kyrn/login';

/** A runner that says what a test tells it to and records what it is sent. No process, no pi, no network. */
class FakeRunner extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  readonly sent: Record<string, unknown>[] = [];
  killed = false;

  constructor(readonly args: string[]) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) this.sent.push(JSON.parse(line) as Record<string, unknown>);
    });
  }

  say(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  end(code: number): void {
    this.stdout.end();
    this.emit('close', code);
  }

  kill(): void {
    this.killed = true;
  }
}

function setup() {
  const runners: FakeRunner[] = [];
  const opened: string[] = [];
  const manager = new LoginManager(
    (args) => {
      const runner = new FakeRunner(args);
      runners.push(runner);
      return runner as unknown as RunnerProcess;
    },
    (url) => opened.push(url)
  );
  return { manager, runners, opened };
}

/** Lines are read asynchronously, as from a real child. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  vi.useRealTimers();
});

describe('signing in to a subscription', () => {
  it('opens only the provider page, passes the typed code on, and ends with the account’s models', async () => {
    const { manager, runners, opened } = setup();
    expect(manager.start('anthropic')).toMatchObject({ id: 1, provider: 'anthropic', phase: 'running' });
    const runner = runners[0];
    expect(runner.args).toEqual(['login', 'anthropic']);

    runner.say({ type: 'event', event: { type: 'auth_url', url: 'https://claude.ai/oauth/authorize?state=s' } });
    runner.say({ type: 'event', event: { type: 'auth_url', url: 'file:///etc/hosts' } });
    runner.say({ type: 'prompt', prompt: { type: 'manual_code', message: 'Paste the code' } });
    await settle();
    expect(opened).toEqual(['https://claude.ai/oauth/authorize?state=s']);
    expect(manager.state()).toMatchObject({
      url: 'https://claude.ai/oauth/authorize?state=s',
      prompt: { type: 'manual_code', message: 'Paste the code' },
    });

    manager.answer(1, 'the-code');
    await settle();
    expect(runner.sent).toEqual([{ type: 'answer', value: 'the-code' }]);
    expect(manager.state().prompt).toBeUndefined();

    runner.say({
      type: 'done',
      provider: 'anthropic',
      models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }, { id: 'claude-fable-5' }, { name: 'no id' }],
    });
    runner.end(0);
    await settle();
    expect(manager.state()).toMatchObject({
      phase: 'done',
      models: [
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
        { id: 'claude-fable-5', name: 'claude-fable-5' },
      ],
    });
  });

  it('keeps the flow’s own error, even when the runner ends right after it', async () => {
    const { manager, runners } = setup();
    manager.start('openai-codex');
    runners[0].say({ type: 'error', message: 'Token exchange request failed' });
    runners[0].end(1);
    await settle();
    expect(manager.state()).toMatchObject({ phase: 'failed', error: 'Token exchange request failed' });

    manager.start('openai-codex');
    runners[1].end(1);
    await settle();
    expect(manager.state()).toMatchObject({ id: 2, phase: 'failed', error: 'The sign-in stopped' });
  });

  it('cancels: the runner is told, then ended, and what it says afterwards changes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { manager, runners } = setup();
    manager.start('anthropic');
    expect(manager.cancel()).toMatchObject({ phase: 'cancelled' });
    await vi.advanceTimersByTimeAsync(5);
    expect(runners[0].sent).toEqual([{ type: 'cancel' }]);
    expect(runners[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(runners[0].killed).toBe(true);

    runners[0].say({ type: 'error', message: 'cancelled' });
    runners[0].end(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(manager.state()).toMatchObject({ phase: 'cancelled' });
    expect(manager.state().error).toBeUndefined();
  });

  it('ends the older sign-in when another starts, and drops what belongs to the older one', async () => {
    const { manager, runners } = setup();
    manager.start('anthropic');
    manager.start('openai-codex');
    await settle();
    expect(runners[0].sent).toEqual([{ type: 'cancel' }]);

    runners[0].say({ type: 'done', provider: 'anthropic', models: [{ id: 'old' }] });
    runners[1].say({ type: 'prompt', prompt: { type: 'manual_code', message: 'code' } });
    await settle();
    expect(manager.state()).toMatchObject({ id: 2, provider: 'openai-codex', phase: 'running' });

    manager.answer(1, 'for the old one');
    await settle();
    expect(runners[1].sent).toEqual([]);
    expect(manager.state().prompt).toBeDefined();
  });

  it('shows a device code, opens its page, and keeps the page to open again', async () => {
    const { manager, runners, opened } = setup();
    manager.start('xai');
    expect(runners[0].args).toEqual(['login', 'xai']);
    runners[0].say({
      type: 'event',
      event: {
        type: 'device_code',
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://accounts.x.ai/device?code=WDJB-MJHT',
      },
    });
    await settle();
    expect(opened).toEqual(['https://accounts.x.ai/device?code=WDJB-MJHT']);
    expect(manager.state()).toMatchObject({
      device: { userCode: 'WDJB-MJHT', verificationUri: 'https://accounts.x.ai/device?code=WDJB-MJHT' },
      url: 'https://accounts.x.ai/device?code=WDJB-MJHT',
    });

    manager.start('xai');
    runners[1].say({
      type: 'event',
      event: { type: 'device_code', userCode: 'X', verificationUri: 'file:///etc/hosts' },
    });
    await settle();
    expect(opened).toHaveLength(1);
    expect(manager.state()).toMatchObject({ device: { userCode: 'X', verificationUri: '' } });
    expect(manager.state().url).toBeUndefined();
  });

  it('asks the Google risk question as the flow puts it, and a no to it is a cancel, not a failure', async () => {
    const { manager, runners, opened } = setup();
    manager.start('google-gemini-cli');
    runners[0].say({
      type: 'prompt',
      prompt: {
        type: 'select',
        message: 'Experimental: this signs in through Gemini CLI’s own login…',
        options: [
          { id: 'continue', label: 'I understand the risk, sign in' },
          { id: 'cancel', label: 'Cancel' },
        ],
      },
    });
    await settle();
    expect(manager.state().prompt).toMatchObject({ type: 'select', options: [{ id: 'continue' }, { id: 'cancel' }] });
    expect(opened).toEqual([]);

    manager.answer(1, 'cancel');
    runners[0].say({ type: 'error', message: 'Login cancelled' });
    runners[0].end(1);
    await settle();
    expect(runners[0].sent).toEqual([{ type: 'answer', value: 'cancel' }]);
    expect(manager.state()).toMatchObject({ phase: 'cancelled' });
    expect(manager.state().error).toBeUndefined();
  });

  it('knows the account is signed in once the credential is stored, before its models are read', async () => {
    const { manager, runners } = setup();
    manager.start('google-antigravity');
    runners[0].say({ type: 'prompt', prompt: { type: 'manual_code', message: 'paste' } });
    runners[0].say({ type: 'signed_in' });
    await settle();
    expect(manager.state()).toMatchObject({ phase: 'running', stored: true });
    expect(manager.state().prompt).toBeUndefined();
  });

  it('stops a sign-in nobody finishes, after a quarter of an hour, but not one already signed in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { manager, runners } = setup();
    manager.start('google-gemini-cli');
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(manager.state().phase).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.state()).toMatchObject({ phase: 'failed', error: 'The sign-in waited too long and was stopped' });
    expect(runners[0].sent).toEqual([{ type: 'cancel' }]);

    manager.start('google-antigravity');
    runners[1].say({ type: 'signed_in' });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(manager.state()).toMatchObject({ phase: 'running', stored: true });
  });

  it('refuses a provider it does not offer', () => {
    const { manager, runners } = setup();
    expect(() => manager.start('google' as never)).toThrow('Unknown provider');
    expect(runners).toEqual([]);
  });
});

describe('who is signed in', () => {
  it('reads the accounts and the sign-ins the runner reports, and only the ones the app knows', async () => {
    const { manager, runners } = setup();
    const status = manager.status();
    expect(runners[0].args).toEqual(['status']);
    runners[0].say({
      type: 'status',
      offered: ['openai-codex', 'anthropic', 'xai', 'google-antigravity', 'github-copilot'],
      signedIn: [
        { provider: 'anthropic', models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }] },
        { provider: 'google-antigravity', models: [{ id: 'gemini-3-flash' }] },
        { provider: 'github-copilot', models: [{ id: 'g' }] },
      ],
    });
    runners[0].end(0);
    await expect(status).resolves.toEqual({
      offered: ['openai-codex', 'anthropic', 'xai', 'google-antigravity'],
      signedIn: [
        { provider: 'anthropic', models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }] },
        { provider: 'google-antigravity', models: [{ id: 'gemini-3-flash', name: 'gemini-3-flash' }] },
      ],
    });
  });

  it('leaves out what is offered when an older runner does not say', async () => {
    const { manager, runners } = setup();
    const status = manager.status();
    runners[0].say({ type: 'status', signedIn: [] });
    runners[0].end(0);
    await expect(status).resolves.toEqual({ signedIn: [] });
  });

  it('is nobody when the runner cannot start, ends without a word, or does not answer in time', async () => {
    const failing = new LoginManager(
      () => {
        throw new Error('no node');
      },
      () => undefined
    );
    await expect(failing.status()).resolves.toEqual({ signedIn: [] });

    const { manager, runners } = setup();
    const quiet = manager.status();
    runners[0].end(1);
    await expect(quiet).resolves.toEqual({ signedIn: [] });

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const slow = manager.status(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(slow).resolves.toEqual({ signedIn: [] });
    expect(runners[1].killed).toBe(true);
  });
});

describe('signing out', () => {
  it('asks the runner to sign out of that one account and reads who is left', async () => {
    const { manager, runners } = setup();
    const left = manager.logout('anthropic');
    expect(runners[0].args).toEqual(['logout', 'anthropic']);
    runners[0].say({ type: 'status', signedIn: [{ provider: 'openai-codex', models: [] }] });
    runners[0].end(0);
    await expect(left).resolves.toEqual({ signedIn: [{ provider: 'openai-codex', models: [] }] });
  });

  it('fails with the runner’s own words, and refuses a provider it does not offer', async () => {
    const { manager, runners } = setup();
    const failed = manager.logout('openai-codex');
    runners[0].say({ type: 'error', message: 'Credential store delete failed for openai-codex' });
    runners[0].end(1);
    await expect(failed).rejects.toThrow('Credential store delete failed for openai-codex');
    await expect(manager.logout('google' as never)).rejects.toThrow('Unknown provider');
    expect(runners).toHaveLength(1);
  });
});

describe('what the sign-in may open and run', () => {
  it('opens web pages only', () => {
    expect(openable('https://auth.openai.com/oauth/authorize?x=1')).toBe(true);
    expect(openable('http://localhost:1455/auth/callback')).toBe(false);
    expect(openable('file:///etc/hosts')).toBe(false);
    expect(openable('javascript:alert(1)')).toBe(false);
    expect(openable('not a url')).toBe(false);
    expect(openable(undefined)).toBe(false);
  });

  it('runs on the harness’s own tsx, found from its checkout upwards, and the desktop’s only without one', () => {
    const root = join('/work', 'KYRN', '.claude', 'worktrees', 'w');
    const main = join('/work', 'KYRN', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    expect(findTsx(root, '/desk', (path) => path === main)).toBe(main);
    expect(findTsx(root, '/desk', () => false)).toBe(join('/desk', 'node_modules', 'tsx', 'dist', 'cli.mjs'));
  });
});
