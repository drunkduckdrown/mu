/**
 * Signs in to a provider's subscription with pi's own OAuth flow, outside any conversation, and stores the
 * credential where pi reads it (`<agent dir>/auth.json`), exactly as `/login` in the terminal does. The desktop's
 * main process runs it through tsx, with the harness's tsconfig (pi runs from source):
 *
 *   node tsx/dist/cli.mjs --tsconfig <KYRN_ROOT>/tsconfig.json loginRunner.ts login <provider>
 *   node tsx/dist/cli.mjs --tsconfig <KYRN_ROOT>/tsconfig.json loginRunner.ts status
 *   node tsx/dist/cli.mjs --tsconfig <KYRN_ROOT>/tsconfig.json loginRunner.ts logout <provider>
 *
 * with KYRN_ROOT (the harness checkout) and MU_LOGIN_AGENT_DIR set. It speaks JSON lines: events, prompts and the
 * result on stdout, answers and a cancel on stdin. It never prints a credential.
 *
 * pi's own flows (ChatGPT, Claude, Grok) are always there. The Google sign-ins are mu's harness's: they are added
 * when the harness has them and its `googleLogin` feature is on, as the harness itself adds them to `/login`.
 */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Json = Record<string, unknown>;
type Prompt = { type: string; message: string; placeholder?: string; options?: unknown; signal?: AbortSignal };
type Interaction = { signal: AbortSignal; prompt(prompt: Prompt): Promise<string>; notify(event: Json): void };
type Provider = { id: string };
type Runtime = {
  login(provider: string, type: 'oauth', interaction: Interaction): Promise<unknown>;
  logout(provider: string): Promise<void>;
  getModels(provider?: string): readonly { id: string; name?: string }[];
  listCredentials(): Promise<readonly { providerId: string; type: string }[]>;
  registerNativeProvider(provider: Provider): void;
  refresh(options: { providers?: string[]; allowNetwork?: boolean; signal?: AbortSignal }): Promise<unknown>;
};
type GoogleOptions = { enabled: boolean; geminiCli: boolean; antigravity: boolean };

/** pi's own subscription flows, in every harness. */
const BUILT_IN = ['openai-codex', 'anthropic', 'xai'];
/** A provider whose list of models comes from the account: read again once it is signed in. */
const LISTED_BY_ACCOUNT = new Set(['google-antigravity']);
/** How long that reading may take: the sign-in itself is done by then, and the list it had stands. */
const MODELS_READ_MS = 20_000;
/** pi's Codex flow asks how to sign in; from the app it is always the browser on this machine, never the headless way. */
const BROWSER_METHOD = 'browser';
const say = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** What an account can use, from pi's catalogue, with the model pi starts that provider on first. */
function modelsOf(runtime: Runtime, provider: string, preferred: Record<string, string>) {
  const models = runtime.getModels(provider).map((model) => ({ id: model.id, name: model.name || model.id }));
  const first = models.findIndex((model) => model.id === preferred[provider]);
  return first > 0 ? [models[first], ...models.slice(0, first), ...models.slice(first + 1)] : models;
}

/**
 * The Google providers of the harness, when it has them and they are on (its `googleLogin` feature, read from the
 * user's own mu.json the way the harness reads it). Anything missing or broken means none: pi's flows still work.
 */
async function googleProviders(root: string, agentDir: string): Promise<Provider[]> {
  const providersFile = join(root, 'packages/kyrn-judge/src/google-login/providers.ts');
  if (!existsSync(providersFile)) return [];
  try {
    const config = (await import(pathToFileURL(join(root, 'packages/kyrn-judge/src/config.ts')).href)) as {
      loadConfig(source: { dir: string }): { config: unknown; disabled: boolean };
      featureOptions(config: unknown, name: string, defaults: GoogleOptions): GoogleOptions;
    };
    const loaded = config.loadConfig({ dir: agentDir });
    if (loaded.disabled) return [];
    const options = config.featureOptions(loaded.config, 'googleLogin', {
      enabled: true,
      geminiCli: true,
      antigravity: true,
    });
    if (!options.enabled) return [];
    const google = (await import(pathToFileURL(providersFile).href)) as {
      geminiCliProvider(): Provider;
      antigravityProvider(): Provider;
    };
    return [
      ...(options.geminiCli ? [google.geminiCliProvider()] : []),
      ...(options.antigravity ? [google.antigravityProvider()] : []),
    ];
  } catch {
    return [];
  }
}

const isBrowserChoice = (prompt: Prompt) =>
  prompt.type === 'select' &&
  Array.isArray(prompt.options) &&
  prompt.options.some((option) => (option as Json | null)?.id === BROWSER_METHOD);

async function main(): Promise<void> {
  const [mode, provider] = process.argv.slice(2);
  const root = process.env.KYRN_ROOT;
  const agentDir = process.env.MU_LOGIN_AGENT_DIR;
  if (!root || !agentDir) throw new Error('KYRN_ROOT and MU_LOGIN_AGENT_DIR are required');
  const runtimeModule = pathToFileURL(join(root, 'packages/coding-agent/src/core/model-runtime.ts')).href;
  const { ModelRuntime } = (await import(runtimeModule)) as {
    ModelRuntime: { create(options: Json): Promise<Runtime> };
  };
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  const resolver = pathToFileURL(join(root, 'packages/coding-agent/src/core/model-resolver.ts')).href;
  const preferred = await import(resolver).then(
    (module: { defaultModelPerProvider?: Record<string, string> }) => module.defaultModelPerProvider ?? {},
    (): Record<string, string> => ({})
  );

  const google = await googleProviders(root, agentDir);
  for (const extra of google) runtime.registerNativeProvider(extra);
  if (google.length) await runtime.refresh({ allowNetwork: false, providers: google.map((extra) => extra.id) });
  const offered = [...BUILT_IN, ...google.map((extra) => extra.id)];

  const credentials = () => runtime.listCredentials();
  const status = async () => ({
    type: 'status',
    offered,
    signedIn: (await credentials())
      .filter((credential) => credential.type === 'oauth' && offered.includes(credential.providerId))
      .map((credential) => ({
        provider: credential.providerId,
        models: modelsOf(runtime, credential.providerId, preferred),
      })),
  });

  if (mode === 'status') {
    say(await status());
    return;
  }
  const usage = 'usage: login <provider> | logout <provider> | status';
  if (!provider) throw new Error(usage);
  if (!offered.includes(provider)) throw new Error(`Signing in to ${provider} is not available in this harness`);
  if (mode === 'logout') {
    // Only a subscription sign-in is signed out here: a key stored for the same provider is left alone.
    const stored = (await credentials()).find((credential) => credential.providerId === provider);
    if (stored?.type === 'oauth') await runtime.logout(provider);
    say(await status());
    return;
  }
  if (mode !== 'login') throw new Error(usage);

  const controller = new AbortController();
  let pending: { resolve(value: string): void; reject(error: Error): void } | undefined;
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    if (message.type === 'answer' && pending) {
      const waiting = pending;
      pending = undefined;
      waiting.resolve(typeof message.value === 'string' ? message.value : '');
    } else if (message.type === 'cancel') {
      controller.abort();
      pending?.reject(new Error('cancelled'));
    }
  });
  // The app went away: nobody is left to finish the sign-in.
  lines.on('close', () => controller.abort());

  await runtime.login(provider, 'oauth', {
    signal: controller.signal,
    notify: (event) => say({ type: 'event', event }),
    prompt: (prompt) =>
      isBrowserChoice(prompt)
        ? Promise.resolve(BROWSER_METHOD)
        : new Promise<string>((resolve, reject) => {
            const entry = { resolve, reject };
            pending = entry;
            // A prompt raced against the browser callback is withdrawn when the callback wins.
            prompt.signal?.addEventListener(
              'abort',
              () => {
                if (pending !== entry) return;
                pending = undefined;
                reject(new Error('withdrawn'));
                say({ type: 'prompt_done' });
              },
              { once: true }
            );
            say({
              type: 'prompt',
              prompt: {
                type: prompt.type,
                message: prompt.message,
                placeholder: prompt.placeholder,
                options: prompt.options,
              },
            });
          }),
  });
  // The credential is stored: whatever happens next, the person is signed in.
  say({ type: 'signed_in' });
  if (LISTED_BY_ACCOUNT.has(provider)) {
    // What the account can use now; when that cannot be read in time, the list it had before sign-in stands.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(MODELS_READ_MS)]);
    await runtime.refresh({ providers: [provider], allowNetwork: true, signal }).catch(() => {});
  }
  say({ type: 'done', provider, models: modelsOf(runtime, provider, preferred) });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    say({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
);
