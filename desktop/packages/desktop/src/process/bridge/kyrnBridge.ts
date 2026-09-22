import { join, resolve } from 'node:path';
import { shell } from 'electron';
import { kyrnBridge } from '../../common/kyrn/bridge';
import { KyrnError, kyrnFailure, type KyrnResult } from '../../common/kyrn/errors';
import type { KyrnCatalog } from '../../common/kyrn/types';
import { httpRequest } from '../../common/adapter/httpBridge';
import { SettingsStore } from '../agent/kyrn/settings';
import { availableModels } from '../agent/kyrn/config/available';
import { LoginManager, openable, spawnLoginRunner } from '../agent/kyrn/login';
import { testProvider } from '../agent/kyrn/config/connection';
import { LocalJudge } from '../agent/kyrn/localJudge';
import { activityPage } from '../agent/kyrn/telemetry';
import { findRegistration, initializeKyrn } from '../agent/kyrn/product';
import { muEnv, muHome } from '../agent/kyrn/naming';
import { asRecord, text } from '../agent/kyrn/piRpc';
import { sessionBinding } from '../agent/kyrn/sessionBinding';
import { getDataPath } from '../utils/utils';

// Always answer IPC, including failure: the generic bridge otherwise only logs exceptions.
async function result<T>(work: () => T | Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

export function initKyrnBridge(): void {
  const root = resolve(process.env.KYRN_ROOT || join(process.cwd(), '../KYRN'));
  const home = muHome();
  const agentDir = muEnv('AGENT_DIR') || join(home, 'agent');
  const store = join(home, 'acp-sessions');
  const settings = new SettingsStore(agentDir, root);
  const command = join(process.env.KYRN_DESKTOP_ROOT || process.cwd(), 'scripts/kyrn/acp');
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
  const login = new LoginManager(
    spawnLoginRunner(root, agentDir, process.env.KYRN_DESKTOP_ROOT || process.cwd()),
    (url) => {
      if (openable(url)) void shell.openExternal(url);
    }
  );
  kyrnBridge.loginStart.provider(({ provider }) => result(() => login.start(provider)));
  kyrnBridge.loginState.provider(() => result(() => login.state()));
  kyrnBridge.loginAnswer.provider(({ id, value }) => result(() => login.answer(id, value)));
  kyrnBridge.loginCancel.provider(() => result(() => login.cancel()));
  kyrnBridge.loginStatus.provider(() => result(() => login.status()));
  kyrnBridge.loginLogout.provider(({ provider }) => result(() => login.logout(provider)));
  const localJudge = new LocalJudge(root);
  kyrnBridge.localJudgeState.provider(() => result(() => localJudge.state()));
  kyrnBridge.localJudgeRun.provider(({ action, consent }) => result(() => localJudge.run(action, consent === true)));
  kyrnBridge.activity.provider((input) =>
    result(async () => {
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.conversationId)) throw new KyrnError('invalid', 'Invalid conversation');
      const conversation = await httpRequest<Record<string, unknown>>(
        'GET',
        `/api/conversations/${input.conversationId}`
      );
      const extra = asRecord(conversation.extra);
      const sessionId = sessionBinding(getDataPath(), input.conversationId, text(extra.agent_id));
      if (!sessionId) return { sessionId: '', cursor: 0, more: false, events: [] };
      return activityPage(store, sessionId, input.sessionId === sessionId ? input.cursor : 0);
    })
  );
}
