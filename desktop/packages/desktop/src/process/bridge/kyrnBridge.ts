import { basename, dirname, join, resolve } from 'node:path';
import { app, shell, utilityProcess } from 'electron';
import { kyrnBridge } from '../../common/kyrn/bridge';
import { KyrnError, kyrnFailure, type KyrnResult } from '../../common/kyrn/errors';
import type { KyrnCatalog } from '../../common/kyrn/types';
import { httpRequest } from '../../common/adapter/httpBridge';
import { SettingsStore } from '../agent/kyrn/settings';
import { availableModels } from '../agent/kyrn/config/available';
import { LoginManager, openable, spawnLoginRunner } from '../agent/kyrn/login';
import { testProvider } from '../agent/kyrn/config/connection';
import { envFileOf, findHarness, manifestOf } from '../agent/kyrn/harness';
import { LocalJudge } from '../agent/kyrn/localJudge';
import { OnnxLocalJudge, openFolder, usesOnnxJudge } from '../agent/kyrn/localJudgeOnnx';
import { LessonsStore, lessonsProject, type LessonsProject } from '../agent/kyrn/lessons';
import { activityPage, modelLevels } from '../agent/kyrn/telemetry';
import { findRegistration, initializeKyrn } from '../agent/kyrn/product';
import { muEnv, muHome } from '../agent/kyrn/naming';
import { asRecord, text } from '../agent/kyrn/piRpc';
import { sessionBinding } from '../agent/kyrn/sessionBinding';
import { getDataPath } from '../utils/utils';

/** `out/main/localJudgeOnnx.js`, next to the main entry even when this module sits in `out/main/chunks/`. */
function localJudgeEntry(): string {
  const main = require.main?.filename ? dirname(require.main.filename) : __dirname;
  return join(basename(main) === 'chunks' ? dirname(main) : main, 'localJudgeOnnx.js');
}

// Always answer IPC, including failure: the generic bridge otherwise only logs exceptions.
async function result<T>(work: () => T | Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

const isKindName = (kind: unknown): kind is string => typeof kind === 'string' && /^[\w.-]{1,64}$/.test(kind);

/** The event kinds an activity reader may ask for: a few names, never a pattern. */
function activityKinds(kinds: unknown): string[] | undefined {
  if (kinds === undefined) return undefined;
  if (!Array.isArray(kinds) || kinds.length > 16 || !kinds.every(isKindName))
    throw new KyrnError('invalid', 'Invalid activity kinds');
  return kinds;
}

/**
 * An app conversation as mu sees it: its `extra` (the workspace among it), and the mu session behind it, '' when mu
 * does not run it (another agent, or not started yet).
 */
async function conversationOf(conversationId: string): Promise<{ extra: Record<string, unknown>; sessionId: string }> {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(conversationId)) throw new KyrnError('invalid', 'Invalid conversation');
  const conversation = await httpRequest<Record<string, unknown>>('GET', `/api/conversations/${conversationId}`);
  const extra = asRecord(conversation.extra);
  return { extra, sessionId: sessionBinding(getDataPath(), conversationId, text(extra.agent_id)) };
}

const sessionOf = async (conversationId: string): Promise<string> => (await conversationOf(conversationId)).sessionId;

export function initKyrnBridge(): void {
  const desktopRoot = process.env.KYRN_DESKTOP_ROOT || process.cwd();
  // KYRN_ROOT / MU_ROOT, a checkout beside this one, or mu-agent from npm; else the old default, which then reads
  // as no harness (no manifest) and mu offline.
  // A packaged app runs from no checkout, so nothing is looked for beside the folder it happens to start in.
  const checkout = app.isPackaged && !process.env.KYRN_DESKTOP_ROOT ? undefined : desktopRoot;
  const harness = findHarness(checkout) ?? { root: resolve(desktopRoot, '..', 'KYRN'), layout: 'repo' as const };
  const root = harness.root;
  const home = muHome();
  const agentDir = muEnv('AGENT_DIR') || join(home, 'agent');
  const store = join(home, 'acp-sessions');
  const settings = new SettingsStore(agentDir, root, {
    env: envFileOf(harness, home, process.platform),
    manifest: manifestOf(harness, process.platform),
  });
  // The registration is found by this path, so it stays `acp` where it always was. Windows cannot start a bash
  // script: there the command is acp.cmd, which runs the same adapter with Node. The packaged app has no sources:
  // it carries the adapter bundled (out/main/mu-acp.js) and its launchers in resources/mu.
  const launchers = app.isPackaged ? join(process.resourcesPath, 'mu') : join(desktopRoot, 'scripts', 'kyrn');
  const command = join(launchers, process.platform === 'win32' ? 'acp.cmd' : 'acp');
  let initialization: Promise<KyrnCatalog> | undefined;
  kyrnBridge.catalog.provider(() =>
    result(() => {
      initialization ??= initializeKyrn(httpRequest, command).catch((error) => {
        initialization = undefined;
        throw error;
      });
      return initialization;
    })
  );
  kyrnBridge.settings.provider(() => result(() => settings.read()));
  kyrnBridge.save.provider((input) => result(() => settings.save(input)));
  kyrnBridge.availableModels.provider(() =>
    result(async () => {
      const agents = await httpRequest<Parameters<typeof findRegistration>[0]>('GET', '/api/agents/management');
      return availableModels(findRegistration(agents, command));
    })
  );
  kyrnBridge.testProvider.provider((input) => result(() => testProvider(input, settings.storedKey(input.id))));
  const login = new LoginManager(spawnLoginRunner(root, agentDir, desktopRoot), (url) => {
    if (openable(url)) void shell.openExternal(url);
  });
  kyrnBridge.loginStart.provider(({ provider }) => result(() => login.start(provider)));
  kyrnBridge.loginState.provider(() => result(() => login.state()));
  kyrnBridge.loginAnswer.provider(({ id, value }) => result(() => login.answer(id, value)));
  kyrnBridge.loginCancel.provider(() => result(() => login.cancel()));
  kyrnBridge.loginStatus.provider(() => result(() => login.status()));
  kyrnBridge.loginLogout.provider(({ provider }) => result(() => login.logout(provider)));
  // Core ML on Apple Silicon Macs, the app's own ONNX judge on Windows and Linux: the same state and actions.
  const localJudge = usesOnnxJudge(process.platform, process.arch, process.env)
    ? new OnnxLocalJudge({
        fork: (env) =>
          utilityProcess.fork(localJudgeEntry(), [], { env, stdio: 'pipe', serviceName: 'mu local judge' }),
        open: (folder) => openFolder(folder, (path) => shell.openPath(path)),
      })
    : new LocalJudge(
        root,
        harness.layout === 'package' ? { stateDir: muEnv('LOCAL_JUDGE_RUN_DIR') || join(home, 'local-judge') } : {}
      );
  if (localJudge instanceof OnnxLocalJudge)
    void localJudge.autoStart(agentDir).catch((error: unknown) => console.warn('[mu] local judge autostart:', error));
  kyrnBridge.localJudgeState.provider(() => result(() => localJudge.state()));
  kyrnBridge.localJudgeRun.provider(({ action, consent }) => result(() => localJudge.run(action, consent === true)));
  kyrnBridge.activity.provider((input) =>
    result(async () => {
      const kinds = activityKinds(input.kinds);
      const sessionId = await sessionOf(input.conversationId);
      if (!sessionId) return { sessionId: '', cursor: 0, more: false, events: [] };
      return activityPage(store, sessionId, input.sessionId === sessionId ? input.cursor : 0, kinds);
    })
  );
  kyrnBridge.modelLevels.provider((input) =>
    result(async () => {
      const sessionId = await sessionOf(input.conversationId);
      return sessionId ? modelLevels(store, sessionId) : {};
    })
  );
  const lessons = new LessonsStore(agentDir);
  const projectOf = async (conversationId: string): Promise<LessonsProject> => {
    const { extra, sessionId } = await conversationOf(conversationId);
    return lessonsProject(store, sessionId, text(extra.workspace));
  };
  kyrnBridge.lessons.provider(({ conversationId }) =>
    result(async () => lessons.view(await projectOf(conversationId)))
  );
  kyrnBridge.lessonsChange.provider((change) =>
    result(async () => lessons.change(await projectOf(change.conversationId), change))
  );
}
