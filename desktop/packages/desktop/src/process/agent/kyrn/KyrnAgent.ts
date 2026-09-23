import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PiRpc, array, asRecord, text, type JsonRecord, type RpcPort } from './piRpc.ts';
import { mapEvent, messageText, messageThinking } from './events.ts';
import { isConversationId, readImportRecord, writeImportRecord, type ImportRecord } from './importChats.ts';
import { muHome } from './naming.ts';
import { Telemetry } from './telemetry.ts';
import { slashCommands } from './commands.ts';
import { supportedThinkingLevels, UNOFFERED_PROVIDER_IDS } from '../../../common/kyrn/models.ts';
import {
  answerIndex,
  answerKind,
  answerOptionId,
  asks,
  isModeId,
  modeOption,
  permissionCall,
  presentation,
  readModes,
  readRequest,
  type PermissionModes,
  type PermissionRequest,
} from './permissions.ts';

type Connection = Pick<AgentSideConnection, 'sessionUpdate' | 'requestPermission'>;
type Session = {
  rpc: RpcPort;
  telemetry: Telemetry;
  refreshing?: Promise<void>;
  dirty?: boolean;
  queue: Promise<void>;
  busy: boolean;
  cancelled: boolean;
  cwd: string;
  streamed: string;
  thought: string;
  error?: Error;
  started?: boolean;
  settled?: () => void;
  /** Set once the session has answered its first state: later mode changes are announced to the app. */
  opened?: boolean;
  /** mu's session file, kept with the conversation's mode in the adapter's record. */
  file?: string;
  /** mu's permission modes, from its last `permissions.mode` event; unset while mu reports none. */
  permissions?: PermissionModes;
  /** What mu said about the permission question it is about to ask. */
  request?: PermissionRequest;
  /** Mode switches from the app in flight: mu's own "switched" note is not shown as a reply then. */
  switching: number;
};
type RpcFactory = (
  cwd: string,
  file: string | undefined,
  onEvent: (event: JsonRecord) => void,
  /** The adapter session this harness process serves. */
  sessionId?: string,
  /** Added to the environment of the harness process. */
  env?: Readonly<Record<string, string>>
) => RpcPort;

/**
 * The errors this bridge raises into a conversation, in plain English. The bridge runs without i18n and what it
 * raises is stored with the conversation, so the desktop recognises these texts and shows its own translation
 * (`renderer/utils/chat/muTurnErrors.ts`, which a test keeps in step with this list).
 */
export const MU_TURN_ERRORS = {
  processExited: 'mu process exited during the turn',
  modelFailed: 'Model request failed',
  turnRunning: 'A mu turn is already running',
  busyConfig: 'Wait for the current turn before changing configuration',
  unsupportedValue: 'Unsupported configuration value',
  permissionsNotSwitched: 'mu did not switch permissions',
  imageUnsupported: 'Unsupported image format or size',
  contentUnsupported: 'This mu adapter accepts text, images and text resources',
  wrongProject: 'Session belongs to a different project',
  notPersisted: 'mu did not persist the session',
} as const;

/**
 * The language the app shows, as the desktop last wrote it to `<mu home>/app-language` for the harness, or undefined
 * when the file is missing or unreadable. Read at every harness start, so a new session follows a language switch.
 *
 * @param home the user's home directory; tests pass a temporary one
 */
export function readAppLanguage(home: string = homedir()): string | undefined {
  try {
    return readFileSync(join(muHome(home), 'app-language'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The environment a harness process gets besides the inherited one. */
export function harnessEnv(sessionId: string | undefined, home?: string): Record<string, string> {
  const language = readAppLanguage(home);
  return {
    // The app's browser bridge learns from this which conversation a browsing run belongs to: the harness hands the
    // value back in its hello, and the app looks the conversation up by the session.
    ...(sessionId ? { MU_DESKTOP_SESSION: sessionId } : {}),
    // The harness words its notices, confirmations and choices in this language.
    ...(language ? { MU_LANG: language } : {}),
  };
}

/** Option ids of the two answers to a harness confirmation; the desktop names them in the reader's language. */
const CONFIRM_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
] as const;

/** ACP adapter only: AionUi owns the UI and projects; mu owns all execution and judgment. */
export class KyrnAgent implements Agent {
  private connection: Connection;
  private store: string;
  private factory: RpcFactory;
  private home: string | undefined;
  private sessions = new Map<string, Session>();
  /**
   * @param home the user's home directory, whose mu home holds the app language; tests pass a temporary one
   */
  constructor(connection: Connection, launcher: string, store: string, factory?: RpcFactory, home?: string) {
    this.connection = connection;
    this.store = store;
    this.home = home;
    this.factory = factory ?? ((cwd, file, onEvent, _sessionId, env) => new PiRpc(launcher, cwd, file, onEvent, env));
    mkdirSync(store, { recursive: true, mode: 0o700 });
  }
  async initialize(): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      // `name` is an identifier the backend has already seen; only the title is shown.
      agentInfo: { name: 'kyrn', title: 'mu', version: '0.1.0' },
      agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: true } },
      authMethods: [],
    };
  }
  async authenticate(): Promise<Record<string, never>> {
    return {};
  }
  private session(id: string): Session {
    const found = this.sessions.get(id);
    if (!found) throw new Error('Unknown mu session');
    return found;
  }
  private path(id: string): string {
    if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('Invalid mu session ID');
    return join(this.store, `${id}.json`);
  }
  private async state(id: string): Promise<JsonRecord> {
    const session = this.session(id);
    const [state, stats] = await Promise.all([
      session.rpc.send({ type: 'get_state' }),
      session.rpc.send({ type: 'get_session_stats' }).catch(() => ({}) as JsonRecord),
    ]);
    session.telemetry.context({ ...state, sessionTokens: stats.tokens });
    return state;
  }
  private refresh(id: string): void {
    const session = this.session(id);
    session.dirty = true;
    if (session.refreshing) return;
    session.refreshing = (async () => {
      while (session.dirty && this.sessions.has(id)) {
        session.dirty = false;
        // Re-read after a burst so a compaction never leaves the old token count on screen.
        // eslint-disable-next-line no-await-in-loop
        await this.state(id);
      }
    })()
      .catch((): void => {})
      .finally(() => {
        session.refreshing = undefined;
      });
  }
  /** The adapter's record of a conversation: where mu keeps it, and the permission mode it was last in. */
  private save(id: string, session: Session): void {
    const path = this.path(id);
    const record = { cwd: session.cwd, file: session.file, permissions: session.permissions?.mode };
    writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  private async attach(id: string, cwd: string, file?: string, permissions?: string): Promise<void> {
    if (this.sessions.has(id)) return;
    const session = {
      queue: Promise.resolve(),
      busy: false,
      cancelled: false,
      cwd,
      streamed: '',
      thought: '',
      switching: 0,
    } as Session;
    this.sessions.set(id, session);
    const telemetry = new Telemetry(this.store, id);
    session.telemetry = telemetry;
    const onEvent = (event: JsonRecord): void => {
      telemetry.capture(event);
      if (
        [
          'agent_start',
          'agent_settled',
          'message_end',
          'tool_execution_end',
          'compaction_start',
          'compaction_end',
        ].includes(text(event.type))
      ) {
        this.refresh(id);
      }
      if (event.type === 'agent_start') session.started = true;
      if (event.type === 'agent_settled') session.settled?.();
      if (event.type === 'kyrn_rpc_closed') {
        session.error = new Error(MU_TURN_ERRORS.processExited);
        session.settled?.();
      }
      if (event.type === 'message_start' && asRecord(event.message).role === 'assistant') {
        session.streamed = '';
        session.thought = '';
      }
      this.permissionEvent(id, session, event);
      const quiet =
        session.switching > 0 &&
        event.type === 'extension_ui_request' &&
        event.method === 'notify' &&
        event.notifyType === 'info';
      const updates = quiet ? [] : mapEvent(event);
      for (const update of updates) {
        if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text')
          session.thought += update.content.text;
        if (
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text' &&
          event.type === 'message_update'
        ) {
          session.streamed += update.content.text;
        }
      }
      if (event.type === 'message_end') {
        const message = asRecord(event.message);
        const thought = messageThinking(message.content);
        if (
          message.role === 'assistant' &&
          thought.startsWith(session.thought) &&
          thought.length > session.thought.length
        ) {
          updates.push({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: thought.slice(session.thought.length) },
          });
          session.thought = thought;
        }
        if (message.role === 'assistant') {
          // The provider's own text follows a fixed headline, which the desktop translates.
          const detail = text(message.errorMessage);
          session.error =
            message.stopReason === 'error'
              ? new Error(detail ? `${MU_TURN_ERRORS.modelFailed}: ${detail}` : MU_TURN_ERRORS.modelFailed)
              : undefined;
        }
        // Some providers finish with authoritative text without emitting text deltas.
        // Only forward the unstreamed suffix so ordinary streaming never duplicates the answer.
        const finalText = messageText(message.content);
        if (
          message.role === 'assistant' &&
          finalText.startsWith(session.streamed) &&
          finalText.length > session.streamed.length
        ) {
          updates.push({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: finalText.slice(session.streamed.length) },
          });
          session.streamed = finalText;
        }
      }
      if (
        event.type === 'extension_ui_request' &&
        ['confirm', 'select', 'input', 'editor'].includes(text(event.method))
      ) {
        // Permissions are out-of-band so a pending dialog cannot block cancellation or streaming.
        void this.permission(id, event).catch(() => session.rpc.respond({ id: event.id, cancelled: true }));
        return;
      }
      for (const update of updates)
        session.queue = session.queue
          .then(() => this.connection.sessionUpdate({ sessionId: id, update }))
          .catch((): void => {});
    };
    session.rpc = this.factory(cwd, file, onEvent, id, {
      ...harnessEnv(id, this.home),
      // A reopened conversation starts in the mode it was last in, unless mu's own record of it says otherwise.
      ...(permissions ? { MU_PERMISSIONS: permissions } : {}),
    });
    try {
      const state = await this.state(id);
      // mu announces its mode at startup, before it answers anything, so the options below already carry it.
      session.opened = true;
      if (!state.sessionFile) throw new Error(MU_TURN_ERRORS.notPersisted);
      session.file = text(state.sessionFile);
      this.save(id, session);
    } catch (error) {
      session.rpc.close();
      this.sessions.delete(id);
      throw error;
    }
  }
  /** Keeps what mu says about permissions: its modes for the send box, its next question for the card. */
  private permissionEvent(id: string, session: Session, event: JsonRecord): void {
    const shown = presentation(event);
    if (shown?.kind === 'permissions.mode') {
      const modes = readModes(shown.payload);
      if (!modes) return;
      const before = session.permissions?.mode;
      session.permissions = modes;
      // A switch typed in the conversation, or made by the send box: the picker follows either way.
      if (session.opened && before !== modes.mode) {
        this.announce(id, session);
        // AionCore sets the mode it last saw whenever it reopens a conversation; one that was never switched would
        // otherwise come back in mu's current default, and that set would then switch it (and save it as mu's default).
        try {
          if (session.file) this.save(id, session);
        } catch {
          // The conversation keeps its mode for now; only a reopen can come back in another one.
        }
      }
    }
    if (shown?.kind === 'permissions.request') session.request = readRequest(shown.payload);
    if (shown?.kind === 'permissions.resolved') session.request = undefined;
  }
  private announce(id: string, session: Session): void {
    session.queue = session.queue
      .then(async () => {
        const configOptions = await this.options(id);
        await this.connection.sessionUpdate({
          sessionId: id,
          update: { sessionUpdate: 'config_option_update', configOptions },
        });
      })
      .catch((): void => {});
  }
  /**
   * Switches this conversation with mu's own command. It runs at once, even during a turn: the next call is checked
   * under the new mode. The switch is for this conversation only (`--here`): the app sets a mode by itself too, when it
   * opens a conversation or seeds a new one, and the mode new conversations start in is set in the settings. An older
   * mu, which has no `--here`, makes each switch its default as well.
   */
  private async switchPermissions(id: string, value: string): Promise<SetSessionConfigOptionResponse> {
    const session = this.session(id);
    if (!session.permissions?.modes.some((mode) => mode.id === value)) throw new Error(MU_TURN_ERRORS.unsupportedValue);
    // The app sets the mode it remembers whenever it opens a conversation; the same mode again is no switch (mu
    // would forget what was allowed for this conversation).
    if (session.permissions.mode !== value) {
      session.switching += 1;
      let timer: NodeJS.Timeout | undefined;
      try {
        // A prompt has no deadline in the RPC client; this one is a command that answers at once.
        await Promise.race([
          session.rpc.send({
            type: 'prompt',
            message: `/permissions ${value}${session.permissions.conversationSwitch ? ' --here' : ''}`,
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(MU_TURN_ERRORS.permissionsNotSwitched)), 30000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        session.switching -= 1;
      }
      // mu announces the new mode before it answers the command.
      if (session.permissions.mode !== value) throw new Error(MU_TURN_ERRORS.permissionsNotSwitched);
    }
    return { configOptions: await this.options(id) };
  }
  private async options(id: string): Promise<SessionConfigOption[]> {
    const session = this.session(id);
    const { rpc } = session;
    const [state, models, levels] = await Promise.all([
      this.state(id),
      rpc.send({ type: 'get_available_models' }),
      rpc.send({ type: 'get_available_thinking_levels' }),
    ]);
    const current = asRecord(state.model);
    const currentValue = `${text(current.provider)}/${text(current.id)}`;
    const offered = array(models.models)
      .map(asRecord)
      // A model already in use stays listed, so the picker still shows what the conversation runs on.
      .filter(
        (model) =>
          !UNOFFERED_PROVIDER_IDS.has(text(model.provider)) ||
          `${text(model.provider)}/${text(model.id)}` === currentValue
      );
    // What each model takes, by pi's own rule, beside the options: an ACP select option has no room for it. The send
    // box offers each model with its levels, so one pick can switch both.
    session.telemetry.levels(
      Object.fromEntries(
        offered.map((model) => [
          `${text(model.provider)}/${text(model.id)}`,
          supportedThinkingLevels(model.reasoning === true, asRecord(model.thinkingLevelMap)),
        ])
      )
    );
    return [
      {
        id: 'model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue,
        options: offered.map((model) => ({
          value: `${text(model.provider)}/${text(model.id)}`,
          name: text(model.name) || text(model.id),
          description: text(model.provider),
        })),
      },
      {
        id: 'thinking',
        category: 'thought_level',
        name: 'Thinking',
        type: 'select',
        currentValue: text(state.thinkingLevel),
        options: array(levels.levels).map((level) => ({ value: text(level), name: text(level) })),
      },
      ...(session.permissions ? [modeOption(session.permissions)] : []),
    ];
  }
  /**
   * Tells the app which slash commands mu has, for the send box's `/` menu. Called as a session is answered: the app
   * keeps a session's commands only once it knows the session, so this runs after the answer has gone out.
   */
  private advertise(id: string): void {
    setImmediate(() => {
      const session = this.sessions.get(id);
      if (!session) return;
      session.queue = session.queue
        .then(async () => {
          const availableCommands = slashCommands(await session.rpc.send({ type: 'get_commands' }));
          if (!availableCommands.length) return;
          await this.connection.sessionUpdate({
            sessionId: id,
            update: { sessionUpdate: 'available_commands_update', availableCommands },
          });
        })
        .catch((): void => {});
    });
  }
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = randomUUID();
    const cwd = await realpath(params.cwd);
    const imported = await this.importFor(cwd);
    await this.attach(id, cwd, imported?.record.file);
    if (imported) this.adopted(imported.conversationId, imported.record, id);
    const configOptions = await this.options(id);
    this.advertise(id);
    return { sessionId: id, configOptions };
  }
  /**
   * The session a conversation the app made from a Claude Code or Codex transcript goes on with, until an adapter
   * session has opened it (process/agent/kyrn/importChats.ts). The backend starts an adapter for each conversation and
   * names the conversation in the adapter's environment (`AIONUI_CONVERSATION_ID`, the backend's own variable).
   */
  private async importFor(cwd: string): Promise<{ conversationId: string; record: ImportRecord } | undefined> {
    const conversationId = process.env.AIONUI_CONVERSATION_ID;
    if (!isConversationId(conversationId)) return undefined;
    const record = readImportRecord(this.store, conversationId);
    if (!record || record.session || !existsSync(record.file)) return undefined;
    // The conversation runs in the folder the transcript ran in; a folder that moved since cannot take the session.
    const folder = await realpath(record.cwd).catch(() => record.cwd);
    if (folder !== cwd) throw new Error(MU_TURN_ERRORS.wrongProject);
    return { conversationId, record };
  }
  /** Marks an imported session as taken: a conversation reset later starts a session of its own. */
  private adopted(conversationId: string, record: ImportRecord, session: string): void {
    try {
      writeImportRecord(this.store, conversationId, { ...record, session });
    } catch {
      // Unmarked, the conversation's next new session opens the same file again: the conversation, as it was.
    }
  }
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const saved = asRecord(JSON.parse(readFileSync(this.path(params.sessionId), 'utf8')));
    const cwd = await realpath(params.cwd);
    if (saved.cwd !== cwd) throw new Error(MU_TURN_ERRORS.wrongProject);
    const permissions = text(saved.permissions);
    await this.attach(params.sessionId, cwd, text(saved.file), isModeId(permissions) ? permissions : undefined);
    const messages = await this.session(params.sessionId).rpc.send({ type: 'get_messages' });
    for (const item of array(messages.messages).map(asRecord)) {
      if (!['user', 'assistant'].includes(text(item.role))) continue;
      const thought = item.role === 'assistant' ? messageThinking(item.content) : '';
      // Replay must remain ordered with the text immediately following it.
      if (thought) {
        // eslint-disable-next-line no-await-in-loop
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: thought },
          },
        });
      }
      const value = messageText(item.content);
      if (!value) continue;
      // Preserve transcript order; parallel notifications can interleave user and assistant chunks.
      // eslint-disable-next-line no-await-in-loop
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: item.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: value },
        },
      });
    }
    const configOptions = await this.options(params.sessionId);
    this.advertise(params.sessionId);
    return { configOptions };
  }
  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = this.session(params.sessionId);
    if (params.configId === 'mode') return this.switchPermissions(params.sessionId, String(params.value));
    if (session.busy) throw new Error(MU_TURN_ERRORS.busyConfig);
    const options = await this.options(params.sessionId);
    const option = options.find((item) => item.id === params.configId);
    if (
      !option ||
      option.type !== 'select' ||
      !option.options.some((item) => 'value' in item && item.value === params.value)
    )
      throw new Error(MU_TURN_ERRORS.unsupportedValue);
    if (params.configId === 'model') {
      const value = String(params.value);
      const slash = value.indexOf('/');
      await session.rpc.send({ type: 'set_model', provider: value.slice(0, slash), modelId: value.slice(slash + 1) });
    } else await session.rpc.send({ type: 'set_thinking_level', level: params.value });
    const configOptions = await this.options(params.sessionId);
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions },
    });
    return { configOptions };
  }
  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<Record<string, never>> {
    await this.setSessionConfigOption({ sessionId: params.sessionId, configId: 'model', value: params.modelId });
    return {};
  }
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.session(params.sessionId);
    if (session.busy) throw new Error(MU_TURN_ERRORS.turnRunning);
    const images: { type: 'image'; data: string; mimeType: string }[] = [];
    const parts = params.prompt.map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType) || block.data.length > 16 * 1024 * 1024)
          throw new Error(MU_TURN_ERRORS.imageUnsupported);
        images.push({ type: 'image', mimeType: block.mimeType, data: block.data });
        return '';
      }
      if (block.type === 'resource' && 'text' in block.resource) return block.resource.text;
      if (block.type === 'resource_link') return `${block.name}: ${block.uri}`;
      throw new Error(MU_TURN_ERRORS.contentUnsupported);
    });
    session.busy = true;
    session.cancelled = false;
    session.error = undefined;
    session.started = false;
    const completed = new Promise<void>((resolve) => {
      session.settled = resolve;
    });
    try {
      await session.rpc.send({ type: 'prompt', message: parts.join('\n'), ...(images.length ? { images } : {}) });
      // An abort during classification can precede agent_start. Repeat after ACK
      // so cancellation never accidentally launches a fresh model turn.
      if (session.cancelled) await session.rpc.send({ type: 'abort' });
      // pi acknowledges preflight, not turn completion. ACP must remain open until
      // agent_settled, including automatic retries, tools and completion nudges.
      // Extension slash commands can be handled without starting an agent at all.
      const state = await this.state(params.sessionId);
      if (session.started || state.isStreaming || state.isCompacting) await completed;
      await session.queue;
      await this.state(params.sessionId);
      if (session.error) throw session.error;
      return { stopReason: session.cancelled ? 'cancelled' : 'end_turn' };
    } finally {
      session.busy = false;
      session.settled = undefined;
    }
  }
  async cancel(params: CancelNotification): Promise<void> {
    const session = this.session(params.sessionId);
    session.cancelled = true;
    await session.rpc.send({ type: 'abort' });
  }
  private async permission(id: string, event: JsonRecord): Promise<void> {
    const session = this.session(id);
    if (!['confirm', 'select'].includes(text(event.method))) {
      session.rpc.respond({ id: event.id, cancelled: true });
      return;
    }
    const confirm = event.method === 'confirm';
    // A confirmation gets stable ids and kinds, so the desktop words the two answers in the reader's language (the
    // names are the English fallback). The choices of a select are the harness's own text and stay as sent.
    const choices = confirm ? [] : array(event.options).map(text);
    const message = text(event.message);
    // mu's permission question comes right after what it said about it; any other picker keeps the plain shape.
    const request = !confirm && session.request && asks(session.request, choices) ? session.request : undefined;
    session.request = undefined;
    const result = await this.connection.requestPermission({
      sessionId: id,
      toolCall: {
        toolCallId: `permission:${text(event.id)}`,
        ...(request
          ? permissionCall(request, text(event.title))
          : {
              title: text(event.title),
              kind: 'other' as const,
              content: [{ type: 'content' as const, content: { type: 'text' as const, text: message } }],
              // The desktop's permission card shows the input's description, not the content: without it, what the
              // harness asks (the command, the action) never reaches the reader.
              ...(message ? { rawInput: { description: message } } : {}),
            }),
      },
      options: confirm
        ? [...CONFIRM_OPTIONS]
        : choices.map((name, i) => ({
            optionId: answerOptionId(request, i),
            name,
            kind: request ? answerKind(i, choices.length) : ('allow_once' as const),
          })),
    });
    if (result.outcome.outcome === 'cancelled' || session.cancelled) {
      session.rpc.respond({ id: event.id, cancelled: true });
      return;
    }
    const { optionId } = result.outcome;
    if (confirm) {
      if (optionId === 'allow' || optionId === 'reject')
        session.rpc.respond({ id: event.id, confirmed: optionId === 'allow' });
      else session.rpc.respond({ id: event.id, cancelled: true });
      return;
    }
    const index = answerIndex(request, optionId, choices.length);
    if (index < 0) session.rpc.respond({ id: event.id, cancelled: true });
    else session.rpc.respond({ id: event.id, value: choices[index] });
  }
  close(): void {
    for (const session of this.sessions.values()) session.rpc.close();
    this.sessions.clear();
  }
}
