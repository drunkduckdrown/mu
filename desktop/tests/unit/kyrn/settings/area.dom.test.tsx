import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { defaultFeatureState, parseManifest, type OptionInfo, type OptionValue } from '@/common/kyrn/manifest';
import type { KyrnSettings, Result, SaveSettings } from '@/common/kyrn/types';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import SettingsArea from '@/renderer/pages/settings/KyrnSettings/SettingsArea';
import OptionField from '@/renderer/pages/settings/KyrnSettings/fields/OptionField';
import manifestJson from './manifest.fixture.json';
import { withOwnPlaces } from './muState.fixture';

const bridge = vi.hoisted(() => ({
  settings: vi.fn(),
  save: vi.fn(),
  availableModels: vi.fn(),
  testProvider: vi.fn(),
  loginStatus: vi.fn(),
  loginState: vi.fn(),
  loginStart: vi.fn(),
  loginAnswer: vi.fn(),
  loginCancel: vi.fn(),
  loginLogout: vi.fn(),
  localJudgeState: vi.fn(),
  localJudgeRun: vi.fn(),
}));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: {
    settings: { invoke: bridge.settings },
    save: { invoke: bridge.save },
    availableModels: { invoke: bridge.availableModels },
    testProvider: { invoke: bridge.testProvider },
    loginStatus: { invoke: bridge.loginStatus },
    loginState: { invoke: bridge.loginState },
    loginStart: { invoke: bridge.loginStart },
    loginAnswer: { invoke: bridge.loginAnswer },
    loginCancel: { invoke: bridge.loginCancel },
    loginLogout: { invoke: bridge.loginLogout },
    localJudgeState: { invoke: bridge.localJudgeState },
    localJudgeRun: { invoke: bridge.localJudgeRun },
  },
  // As the real one: a failure keeps the code the store gave it.
  unwrap: <T,>(result: Result<T>) => {
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
  },
}));

const i18n = createInstance();
beforeAll(async () => {
  const translation = { common: enCommon, mu: enMu };
  await i18n.init({
    lng: 'en-US',
    // Japanese stands for "any locale that is not Chinese": the manifest has no Japanese, so it reads English.
    resources: {
      'en-US': { translation },
      'ja-JP': { translation },
      'zh-CN': { translation: { common: enCommon, mu: zhMu } },
    },
    interpolation: { escapeValue: false },
  });
});

const harness = parseManifest(manifestJson);
if (harness.status !== 'ok') throw new Error('fixture manifest is not readable');
const { manifest } = harness;

function settings(patch: Partial<KyrnSettings> = {}): KyrnSettings {
  return {
    revision: 'r1',
    tiers: ['jev'],
    judges: {
      jev: { type: 'jev', model: 'jev-latest', baseUrl: '', apiKeyEnv: 'TYPESAFE_API_KEY', timeoutMs: 10000 },
      laya: { type: 'local', model: '', baseUrl: 'http://127.0.0.1:47823', apiKeyEnv: '', timeoutMs: 10000 },
    },
    mode: 'shadow',
    betaCompression: false,
    autoCompaction: true,
    maxContextTokens: 0,
    keys: { TYPESAFE_API_KEY: true },
    harness,
    decisionModes: {},
    features: Object.fromEntries(manifest.features.map((feature) => [feature.name, defaultFeatureState(feature)])),
    models: {
      providers: [
        {
          id: 'relay',
          name: 'Relay',
          api: 'openai-completions',
          baseUrl: 'https://relay.example.com/v1',
          authHeader: false,
          key: 'managed',
          keySet: true,
          headerNames: [],
          models: [
            {
              id: 'plain',
              name: '',
              reasoning: false,
              imageInput: false,
              contextWindow: 128000,
              maxTokens: 16384,
              thinkingLevels: ['off'],
            },
          ],
        },
      ],
      foreign: [],
      defaults: { provider: 'relay', model: 'plain', thinkingLevel: '' },
      commented: false,
      problem: '',
    },
    permissions: { mode: 'jev', from: 'default' },
    boardModel: { supported: true, model: '' },
    ...patch,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  bridge.settings.mockResolvedValue({ ok: true, data: settings() });
  bridge.localJudgeState.mockResolvedValue({
    ok: true,
    data: { support: 'ok', installed: true, running: true, url: 'http://127.0.0.1:47823' },
  });
  bridge.availableModels.mockResolvedValue({
    ok: true,
    data: {
      providers: [
        { id: 'openai-codex', models: [{ id: 'sol', name: 'Sol' }] },
        { id: 'corp-gateway', models: [] },
      ],
      thinkingLevels: [],
    },
  });
  bridge.loginStatus.mockResolvedValue({ ok: true, data: { signedIn: [] } });
  bridge.loginState.mockResolvedValue({ ok: true, data: { id: 0, phase: 'idle' } });
  // The store answers a save with the whole state again.
  bridge.save.mockImplementation(
    async ({ models, permissions, boardModel, credentials: _credentials, ...input }: SaveSettings) => {
      const base = settings();
      return {
        ok: true,
        data: {
          ...base,
          ...input,
          revision: 'r2',
          models: { ...base.models, ...models },
          permissions: { ...base.permissions, ...permissions },
          boardModel: { ...base.boardModel, ...boardModel },
        },
      };
    }
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
);

async function open(section: string) {
  render(<SettingsArea />, { wrapper });
  fireEvent.click(await screen.findByTestId(`mu-nav-${section}`));
}
const option = (feature: string, key: string): OptionInfo =>
  manifest.features.find((item) => item.name === feature)!.options.find((item) => item.key === key)!;

describe('generic option fields', () => {
  function field(info: OptionInfo, value: OptionValue) {
    const onChange = vi.fn();
    render(<OptionField scope='x' option={info} value={value} onChange={onChange} />, { wrapper });
    return { onChange, row: screen.getByTestId(`mu-option-x-${info.key}`) };
  }
  it('draws a boolean as a switch', () => {
    const { onChange, row } = field(option('preflight', 'hints'), true);
    const control = within(row).getByRole('switch', { name: 'Give the model a one-line hint' });
    expect(control).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false, expect.anything());
    expect(within(row).queryByTestId('mu-modified')).not.toBeInTheDocument();
  });
  it('draws a number with its unit and range, and says when a value is out of range', () => {
    const { onChange, row } = field(option('preflight', 'waitMs'), 100);
    // The bounds are numbers in the app language, and the range is a line of its own under the harness's help.
    expect(row).toHaveTextContent('Range 500 – 30,000.');
    expect(row).toHaveTextContent('ms');
    expect(within(row).getByRole('alert')).toHaveTextContent('outside the allowed range');
    expect(within(row).getByTestId('mu-modified')).toBeInTheDocument();
    fireEvent.change(within(row).getByRole('spinbutton'), { target: { value: '9000' } });
    expect(onChange).toHaveBeenLastCalledWith(9000);
  });
  it('draws text, a choice, a list of strings and a list of numbers', () => {
    const text = field(option('swarm', 'defaultAgent'), 'worker');
    fireEvent.change(within(text.row).getByRole('textbox'), { target: { value: 'scout' } });
    expect(text.onChange).toHaveBeenLastCalledWith('scout', expect.anything());

    const choice = field(option('admission', 'testLog'), 'rules');
    expect(choice.row).toHaveTextContent('Drop exact repeats only (lossless)');
    expect(within(choice.row).getByTestId('mu-modified')).toBeInTheDocument();

    const list = field(option('admission', 'passThrough'), ['read', 'edit', 'write']);
    for (const tag of ['read', 'edit', 'write']) expect(list.row).toHaveTextContent(tag);
    expect(within(list.row).queryByTestId('mu-modified')).not.toBeInTheDocument();

    const numbers = field(option('forgetting', 'thresholds'), [40, 85]);
    expect(numbers.row).toHaveTextContent('40');
    expect(within(numbers.row).getByTestId('mu-modified')).toBeInTheDocument();
  });
});

describe('decision points and features from the manifest', () => {
  it('lists every decision under its group and every feature, without knowing any of them', async () => {
    await open('decisions');
    for (const decision of manifest.decisions)
      expect(screen.getByTestId(`mu-decision-${decision.id}`)).toBeInTheDocument();
    for (const group of new Set(manifest.decisions.map((decision) => decision.group)))
      expect(screen.getByTestId(`mu-decision-group-${group}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-nav-features'));
    for (const feature of manifest.features)
      expect(screen.getByTestId(`mu-feature-${feature.name}`)).toBeInTheDocument();
    expect(within(screen.getByTestId('mu-feature-compaction')).getByText('Beta')).toBeInTheDocument();
  });
  it.each([
    ['zh-CN', '消息预判', '生效'],
    ['ja-JP', 'Message preflight', 'Active'],
    ['en-US', 'Message preflight', 'Active'],
  ])('reads the manifest in the language of %s', async (language, title, mode) => {
    await i18n.changeLanguage(language);
    await open('decisions');
    const row = screen.getByTestId('mu-decision-input.preflight');
    expect(row).toHaveTextContent(title);
    expect(within(row).getByText(mode)).toBeInTheDocument();
  });
  it('names a group the manifest leaves unnamed, and reads a harness text in the exact language it has', async () => {
    const preflight = manifestJson.decisions.find((decision) => decision.id === 'input.preflight')!;
    const custom = parseManifest({
      ...manifestJson,
      groups: {},
      decisions: [
        { ...preflight, title: { ...preflight.title, ja: 'メッセージ事前判定' } },
        { ...preflight, id: 'misc.one', group: 'misc' },
      ],
    });
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ harness: custom }) });
    await open('decisions');
    // The desktop knows the harness's groups; one it does not know is "Other", never its raw id.
    expect(screen.getByRole('heading', { name: 'Input' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Other' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'misc' })).not.toBeInTheDocument();
    expect(screen.getByTestId('mu-decision-input.preflight')).toHaveTextContent('Message preflight');
    await act(() => i18n.changeLanguage('ja-JP'));
    expect(screen.getByTestId('mu-decision-input.preflight')).toHaveTextContent('メッセージ事前判定');
  });
  it('filters decisions and features with one search', async () => {
    await open('decisions');
    fireEvent.change(screen.getByPlaceholderText('Search decisions and features'), { target: { value: 'hive' } });
    expect(screen.getByTestId('mu-decision-hive.deliver')).toBeInTheDocument();
    expect(screen.queryByTestId('mu-decision-tool.risk')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-nav-features'));
    expect(screen.getByPlaceholderText('Search decisions and features')).toHaveValue('hive');
    expect(screen.getByTestId('mu-feature-hive')).toBeInTheDocument();
    expect(screen.queryByTestId('mu-feature-guard')).not.toBeInTheDocument();
    // Chinese finds it in an English screen too, and a miss says so.
    fireEvent.change(screen.getByPlaceholderText('Search decisions and features'), { target: { value: '蜂群' } });
    expect(screen.getByTestId('mu-feature-hive')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search decisions and features'), { target: { value: 'zzzz' } });
    expect(screen.getByText('Nothing matches the search.')).toBeInTheDocument();
  });
  it('marks what differs from the default and restores a feature', async () => {
    await open('features');
    const card = screen.getByTestId('mu-feature-preflight');
    expect(within(card).queryByTestId('mu-modified')).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('switch', { name: 'Show the wait and the verdict' }));
    // One marker on the option, one on the feature.
    expect(within(card).getAllByTestId('mu-modified')).toHaveLength(2);
    fireEvent.click(within(card).getByText('Restore defaults'));
    expect(within(card).queryByTestId('mu-modified')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
  });
  it('says the harness is too old without a manifest, and keeps the default mode working', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ harness: { status: 'missing' }, features: {} }) });
    await open('decisions');
    expect(screen.getByText(/too old to describe/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('mu-default-mode')).getByText('Active'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.mode).toBe('active');
    expect(sent).not.toHaveProperty('features');
    expect(sent).not.toHaveProperty('decisionModes');
  });
});

describe('the save bar', () => {
  it('appears with the first change, names the sections, saves everything at once and goes away', async () => {
    await open('decisions');
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('mu-decision-tool.risk')).getByText('Active'));
    fireEvent.click(screen.getByTestId('mu-nav-features'));
    fireEvent.click(
      within(screen.getByTestId('mu-feature-guard')).getByRole('switch', { name: 'Risky command guard' })
    );
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Decision points and Features');
    expect(within(screen.getByTestId('mu-nav-decisions')).getByLabelText('Unsaved changes')).toBeInTheDocument();
    expect(within(screen.getByTestId('mu-nav-models')).queryByLabelText('Unsaved changes')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument());
    expect(bridge.save).toHaveBeenCalledTimes(1);
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.revision).toBe('r1');
    expect(sent.decisionModes).toEqual({ 'tool.risk': 'active' });
    expect(sent.features?.guard.enabled).toBe(false);
    expect(sent).not.toHaveProperty('keys');
    expect(sent).not.toHaveProperty('credentials');
  });
  it('follow default removes the override, and discard puts everything back', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ decisionModes: { 'tool.risk': 'off' } }) });
    await open('decisions');
    const row = screen.getByTestId('mu-decision-tool.risk');
    expect(within(row).getByTestId('mu-modified')).toBeInTheDocument();
    fireEvent.click(within(row).getByText('Follow default (Shadow)'));
    expect(within(row).queryByTestId('mu-modified')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Discard'));
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('mu-decision-tool.risk')).getByTestId('mu-modified')).toBeInTheDocument();
  });
  it('explains a stale revision and offers to reload; another failure shows its reason', async () => {
    bridge.save.mockResolvedValueOnce({
      ok: false,
      code: 'stale',
      error: 'Configuration changed. Reload before saving.',
    });
    await open('context');
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic compaction' }));
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(/Another program .* changed the configuration/)).toBeInTheDocument();
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ revision: 'r9', autoCompaction: true }) });
    fireEvent.click(within(screen.getByTestId('mu-save-bar')).getByText('Reload'));
    await waitFor(() => expect(bridge.settings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument());

    bridge.save.mockResolvedValueOnce({
      ok: false,
      code: 'optionValue',
      params: { feature: 'preflight', option: 'waitMs', problem: 'range' },
      error: 'Invalid value for preflight.waitMs (range)',
    });
    fireEvent.click(await screen.findByTestId('mu-nav-context'));
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic compaction' }));
    fireEvent.click(screen.getByText('Save'));
    // The option is named in the reader's words, from the manifest; the store's English stays out.
    expect(await screen.findByText('Not saved: “Wait at most” is outside the allowed range.')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid value/)).not.toBeInTheDocument();
    expect(within(screen.getByTestId('mu-save-bar')).queryByText('Reload')).not.toBeInTheDocument();
  });
  it('translates a failed save in Chinese too, with list and number formats of the language', async () => {
    await i18n.changeLanguage('zh-CN');
    bridge.save.mockResolvedValueOnce({
      ok: false,
      code: 'sharedKey',
      params: { providers: ['a-b', 'a.b'] },
      error: 'Providers a-b and a.b would share a key',
    });
    await open('context');
    fireEvent.click(screen.getByRole('switch', { name: '自动压缩' }));
    // The common module is the English one in this setup.
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('保存失败：a-b和a.b 会共用同一个密钥变量，请修改其中一个 ID。')).toBeInTheDocument();
    bridge.save.mockResolvedValueOnce({
      ok: false,
      code: 'contextLimit',
      params: { min: 8192, max: 10000000 },
      error: 'Context threshold must be 0 or an integer between 8192 and 10000000',
    });
    fireEvent.click(screen.getByText('Save'));
    expect(
      await screen.findByText('保存失败：上下文上限必须是 0，或 8,192 到 10,000,000 之间的整数。')
    ).toBeInTheDocument();
  });
  it('shows a failed load with a way to try again', async () => {
    bridge.settings.mockResolvedValueOnce({
      ok: false,
      code: 'invalidJson',
      params: { file: '/home/me/.mu/agent/mu.json' },
      error: "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    });
    render(<SettingsArea />, { wrapper });
    // A sentence the reader can act on, naming the file; the parser's own words only as the detail under it.
    expect(await screen.findByText('The settings could not be loaded')).toBeInTheDocument();
    expect(
      screen.getByText('/home/me/.mu/agent/mu.json is not valid JSON. Fix it by hand, then reload.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('mu-error-detail')).toHaveTextContent('at position 1 (line 1 column 2)');
    fireEvent.click(screen.getByText('Reload'));
    expect(await screen.findByTestId('mu-nav-judges')).toBeInTheDocument();
  });
});

describe('models and providers', () => {
  it('lists the subscriptions above the endpoints, each subscription once, and opens the first endpoint', async () => {
    await open('models');
    const list = screen.getByRole('listbox', { name: 'Providers' });
    const names = within(list)
      .getAllByRole('option')
      .map((item) => item.textContent);
    expect(names).toEqual(['ChatGPT', 'Claude', 'Grok', 'Relay', 'corp-gateway']);
    expect(screen.getByTestId('mu-provider-editor')).toHaveTextContent('Relay');
    // mu reported openai-codex too: it is the subscription above, not another built-in provider.
    expect(screen.queryByTestId('mu-provider-item-builtin-openai-codex')).not.toBeInTheDocument();
    const relay = screen.getByTestId('mu-provider-item-custom-0');
    expect(within(relay).getByRole('img', { name: 'Usable' })).toBeInTheDocument();
  });

  it('signs in to a subscription at once, outside the save bar', async () => {
    await open('models');
    fireEvent.click(await screen.findByTestId('mu-provider-item-account-openai-codex'));
    const detail = screen.getByTestId('mu-account-openai-codex');
    expect(detail).toHaveTextContent('Plus / Pro plan');
    expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Not signed in');
    const running = {
      id: 1,
      provider: 'openai-codex',
      phase: 'running',
      url: 'https://auth.openai.com/oauth/authorize',
    };
    bridge.loginStart.mockResolvedValue({ ok: true, data: running });
    bridge.loginState.mockResolvedValue({ ok: true, data: running });
    fireEvent.click(within(detail).getByTestId('mu-account-signin-openai-codex'));
    expect(await screen.findByTestId('mu-login-waiting')).toHaveTextContent('ChatGPT');
    const item = screen.getByTestId('mu-provider-item-account-openai-codex');
    expect(within(item).getByRole('img', { name: 'Signing in…' })).toBeInTheDocument();

    bridge.loginState.mockResolvedValue({
      ok: true,
      data: { ...running, phase: 'done', models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] },
    });
    await waitFor(() => expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Signed in'), {
      timeout: 3000,
    });
    expect(detail).toHaveTextContent('GPT-5.5');
    expect(within(item).getByRole('img', { name: 'Signed in' })).toBeInTheDocument();
    expect(within(detail).getByTestId('mu-account-signout-openai-codex')).toBeInTheDocument();
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    expect(bridge.save).not.toHaveBeenCalled();
  });

  it('signs out only after asking, and shows who is still signed in', async () => {
    bridge.loginStatus.mockResolvedValue({
      ok: true,
      data: { signedIn: [{ provider: 'anthropic', models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }] }] },
    });
    bridge.loginLogout.mockResolvedValue({ ok: true, data: { signedIn: [] } });
    await open('models');
    fireEvent.click(await screen.findByTestId('mu-provider-item-account-anthropic'));
    const detail = screen.getByTestId('mu-account-anthropic');
    await waitFor(() => expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Signed in'));
    fireEvent.click(within(detail).getByTestId('mu-account-signout-anthropic'));
    expect(bridge.loginLogout).not.toHaveBeenCalled();
    const confirm = await screen.findByText('Sign out of Claude? You will need to sign in again to use it.');
    expect(confirm).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Sign out' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(bridge.loginLogout).toHaveBeenCalledWith({ provider: 'anthropic' }));
    await waitFor(() => expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Not signed in'));
    expect(within(detail).getByTestId('mu-account-signin-anthropic')).toBeInTheDocument();
  });

  it('says in the app language when signing out or in did not work, with the raw reason under it', async () => {
    bridge.loginStatus.mockResolvedValue({
      ok: true,
      data: { signedIn: [{ provider: 'anthropic', models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }] }] },
    });
    bridge.loginLogout.mockResolvedValue({
      ok: false,
      code: 'backend',
      error: 'EACCES: permission denied',
      params: { status: 500 },
    });
    await open('models');
    fireEvent.click(await screen.findByTestId('mu-provider-item-account-anthropic'));
    const detail = screen.getByTestId('mu-account-anthropic');
    await waitFor(() => expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Signed in'));
    fireEvent.click(within(detail).getByTestId('mu-account-signout-anthropic'));
    const buttons = await screen.findAllByRole('button', { name: 'Sign out' });
    fireEvent.click(buttons[buttons.length - 1]);
    const problem = await within(detail).findByTestId('mu-login-problem');
    // Its own headline, not the sign-in one; the call's words stay as a detail.
    expect(problem).toHaveTextContent('Signing out did not finish. You can try again.');
    expect(problem).toHaveTextContent('EACCES: permission denied');

    bridge.loginStart.mockResolvedValue({ ok: false, code: 'runtimeOffline', error: 'runtime offline' });
    fireEvent.click(screen.getByTestId('mu-provider-item-account-xai'));
    const xai = screen.getByTestId('mu-account-xai');
    fireEvent.click(within(xai).getByTestId('mu-account-signin-xai'));
    const failed = await within(xai).findByTestId('mu-login-problem');
    expect(failed).toHaveTextContent('Signing in did not finish. You can try again.');
    expect(failed).toHaveTextContent('The mu runtime is not online.');
    // A coded reason says all there is: the raw text is not repeated.
    expect(failed).not.toHaveTextContent('runtime offline');
  });
  it('puts the API format first, and sends a typed key only as a credential', async () => {
    const user = userEvent.setup();
    await open('models');
    const editor = screen.getByTestId('mu-provider-editor');
    expect(within(editor).getByTestId('mu-key-state')).toHaveTextContent('Set');
    await user.click(within(editor).getByTestId('mu-endpoint-select'));
    fireEvent.click(await screen.findByText('Anthropic compatible (Messages)'));
    expect(editor).toHaveTextContent('Without /v1');
    fireEvent.change(within(editor).getByLabelText('API key'), { target: { value: 'sk-typed' } });
    expect(within(editor).getByTestId('mu-key-state')).toHaveTextContent('New key, not saved yet');
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Models and providers');

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.models?.providers[0].api).toBe('anthropic-messages');
    expect(sent.models).not.toHaveProperty('removeEntries');
    expect(sent.credentials).toEqual([{ name: 'MU_PROVIDER_RELAY_API_KEY', value: 'sk-typed' }]);
    expect(JSON.stringify(sent.models)).not.toContain('sk-typed');
  });
  it('adds a provider whose id follows its name, and refuses the id of a built-in or reported provider', async () => {
    await open('models');
    fireEvent.click(screen.getByText('Add provider'));
    const editor = screen.getByTestId('mu-provider-editor');
    expect(
      within(screen.getByTestId('mu-provider-item-custom-1')).getByRole('img', { name: 'Not saved' })
    ).toBeInTheDocument();
    fireEvent.change(within(editor).getByLabelText('Display name'), { target: { value: 'My Proxy (EU)' } });
    expect(within(editor).getByLabelText('ID')).toHaveValue('my-proxy-eu');
    for (const [id, message] of [
      ['openai', 'id of a built-in provider'],
      ['corp-gateway', 'already in use'],
      ['relay', 'already in use'],
      ['Bad Id', 'lowercase letters'],
    ]) {
      fireEvent.change(within(editor).getByLabelText('ID'), { target: { value: id } });
      expect(editor).toHaveTextContent(message);
    }
    expect(within(editor).getByText('Test connection').closest('button')).toBeDisabled();
  });
  it('names providers in words: a new one, the API format of an entry, subscriptions as startup providers', async () => {
    const user = userEvent.setup();
    const base = settings();
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({
        models: {
          ...base.models,
          foreign: [
            {
              id: 'anthropic',
              name: '',
              api: 'anthropic-messages',
              baseUrl: 'https://p.example.com',
              modelCount: 1234,
            },
            { id: 'lab', name: 'Lab', api: 'bedrock-converse', baseUrl: '', modelCount: 1 },
          ],
        },
      }),
    });
    await open('models');
    fireEvent.click(screen.getByText('Add provider'));
    // Not the placeholder id "custom" it was given.
    expect(screen.getByTestId('mu-provider-item-custom-1')).toHaveTextContent(/^New provider$/);
    expect(screen.getByTestId('mu-provider-editor')).toHaveTextContent('New provider');

    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-anthropic'));
    expect(screen.getByTestId('mu-provider-foreign')).toHaveTextContent(
      'Anthropic compatible · https://p.example.com · 1,234 models'
    );
    // An API format this screen does not know goes by what models.json says.
    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-lab'));
    expect(screen.getByTestId('mu-provider-foreign')).toHaveTextContent('bedrock-converse · 1 model');

    await user.click(within(screen.getByTestId('mu-board-model')).getByLabelText('Provider'));
    await waitFor(() => expect(document.querySelectorAll('.arco-select-option').length).toBeGreaterThan(0));
    const offered = [...document.querySelectorAll('.arco-select-option')].map((choice) => choice.textContent);
    expect(offered).toEqual(expect.arrayContaining(['Relay', 'ChatGPT', 'corp-gateway']));
    expect(offered).not.toContain('openai-codex');
  });
  it('tests the connection through the main process and offers the models it listed', async () => {
    bridge.testProvider.mockResolvedValue({
      ok: true,
      data: { ok: true, code: 'ok-models', status: 200, latencyMs: 12, detail: '', models: ['plain', 'fresh-model'] },
    });
    await open('models');
    fireEvent.click(screen.getByText('Test connection'));
    expect(await screen.findByTestId('mu-test-result')).toHaveTextContent('The endpoint lists 2 models.');
    expect(bridge.testProvider).toHaveBeenCalledWith({
      id: 'relay',
      api: 'openai-completions',
      baseUrl: 'https://relay.example.com/v1',
      authHeader: false,
      model: 'plain',
    });
    const offer = screen.getByTestId('mu-model-offer-fresh-model');
    // A listed model is offered with a plus mark and says so in words, not with a "+" glued to its id.
    expect(offer).toHaveTextContent(/^fresh-model$/);
    expect(offer).toHaveAttribute('title', 'Add fresh-model');
    fireEvent.click(offer);
    expect(screen.getByTestId('mu-model-1')).toHaveTextContent('fresh-model');
    expect(screen.queryByTestId('mu-model-offer-fresh-model')).not.toBeInTheDocument();
  });
  it('shows each model on one line and opens one to edit; a model without an id stays open', async () => {
    await open('models');
    const line = screen.getByTestId('mu-model-0');
    expect(line).toHaveTextContent('plain');
    expect(line).toHaveTextContent('128K');
    expect(screen.queryByLabelText('Model ID 1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit plain' }));
    fireEvent.change(screen.getByLabelText('Model ID 1'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('Model ID 1')).not.toBeInTheDocument();
    expect(line).toHaveTextContent('renamed');

    fireEvent.click(screen.getByTestId('mu-model-add'));
    expect(screen.getByLabelText('Model ID 2')).toHaveValue('');
    expect(screen.getByTestId('mu-model-edit-1')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove New model' }));
    expect(screen.queryByTestId('mu-model-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('mu-model-0')).toHaveTextContent('renamed');
  });
  it('words a refused test and the endpoint’s own answer apart, and gives the model id one placeholder', async () => {
    await open('models');
    // The model id field has one placeholder sentence, not two glued ones.
    fireEvent.click(screen.getByRole('button', { name: 'Edit plain' }));
    expect(screen.getByPlaceholderText('Model ID · as the API expects it')).toBeInTheDocument();
    bridge.testProvider.mockResolvedValueOnce({ ok: false, code: 'credential', error: 'Invalid credential' });
    fireEvent.click(screen.getByText('Test connection'));
    const failed = await screen.findByTestId('mu-test-failure');
    expect(failed).toHaveTextContent('The key contains characters a key cannot have');
    expect(failed).not.toHaveTextContent('Invalid credential');
    bridge.testProvider.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, code: 'auth', status: 401, latencyMs: 1200, detail: 'Incorrect API key provided', models: [] },
    });
    fireEvent.click(screen.getByText('Test connection'));
    const result = await screen.findByTestId('mu-test-result');
    expect(within(result).getByText('The key was rejected (HTTP 401).')).toBeInTheDocument();
    expect(within(result).getByText('The endpoint said: Incorrect API key provided')).toBeInTheDocument();
  });
  it('picks the model that writes the board, the recommended ones first, or the conversation’s own', async () => {
    bridge.availableModels.mockResolvedValue({
      ok: true,
      data: {
        providers: [
          {
            id: 'corp-gateway',
            models: [
              { id: 'gpt-5', name: '' },
              { id: 'claude-opus-4-6', name: '' },
            ],
          },
        ],
        thinkingLevels: [],
      },
    });
    await open('models');
    // The startup model is picked in the send box now, not here.
    expect(screen.queryByTestId('mu-defaults')).not.toBeInTheDocument();
    const card = screen.getByTestId('mu-board-model');
    expect(card).toHaveTextContent('None yet: mu asks the first time the board is switched on.');
    expect(card).toHaveTextContent('Pick a provider first');
    const user = userEvent.setup();
    await user.click(within(card).getByLabelText('Provider'));
    fireEvent.click(await screen.findByText('corp-gateway', { selector: '.arco-select-option' }));
    // Nothing is set before a model is picked.
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    await user.click(within(card).getByLabelText('Model'));
    await waitFor(() => expect(document.querySelectorAll('.arco-select-option').length).toBeGreaterThan(1));
    const offered = [...document.querySelectorAll('.arco-select-option')].map((choice) => choice.textContent);
    expect(offered.slice(-2)).toEqual(['claude-opus-4-6 · recommended', 'gpt-5']);
    fireEvent.click(screen.getByText('claude-opus-4-6 · recommended', { selector: '.arco-select-option' }));
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Models and providers');
    expect(card).not.toHaveTextContent('None yet');

    // The conversation's own model, then back to the one picked.
    fireEvent.click(within(card).getByTestId('mu-board-model-session'));
    expect(within(card).getByTestId('mu-board-model-session')).toHaveAttribute('aria-checked', 'true');
    expect(within(card).queryByLabelText('Model')).not.toBeInTheDocument();
    fireEvent.click(within(card).getByTestId('mu-board-model-pick'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    expect((bridge.save.mock.calls[0][0] as SaveSettings).boardModel).toEqual({
      model: 'corp-gateway/claude-opus-4-6',
    });
  });
  it('says when this mu cannot be told which model writes the board', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ boardModel: { supported: false, model: '' } }) });
    await open('models');
    const card = screen.getByTestId('mu-board-model');
    expect(card).toHaveTextContent('Update mu first.');
    expect(within(card).queryByRole('radio')).not.toBeInTheDocument();
  });

  it('removes a provider from its menu after asking, with its key and the startup model that used it', async () => {
    await open('models');
    const editor = screen.getByTestId('mu-provider-editor');
    fireEvent.change(within(editor).getByLabelText('API key'), { target: { value: 'sk-typed' } });
    fireEvent.click(within(editor).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    expect(await screen.findByText('Remove Relay?')).toBeInTheDocument();
    expect(screen.getByText(/deleted from models.json, and so is the key/)).toBeInTheDocument();
    expect(screen.getByText(/the default model is cleared too/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-custom-0')).not.toBeInTheDocument());
    // With no endpoint left, the first subscription is shown.
    expect(screen.getByTestId('mu-account-openai-codex')).toBeInTheDocument();
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Models and providers');

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.models?.providers).toEqual([]);
    expect(sent.models?.defaults).toEqual({ provider: '', model: '', thinkingLevel: '' });
    expect(sent.credentials).toBeUndefined();
  });

  it('keeps a provider when the question is cancelled, and drops one not saved yet without a save', async () => {
    await open('models');
    fireEvent.click(screen.getByText('Add provider'));
    const more = () => within(screen.getByTestId('mu-provider-editor')).getByTestId('mu-provider-more');
    fireEvent.click(more());
    fireEvent.click(await screen.findByText('Remove provider'));
    expect(await screen.findByText(/not saved yet, so what you filled in here is discarded/)).toBeInTheDocument();
    expect(screen.queryByText(/the default model is cleared too/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('mu-provider-item-custom-1')).toBeInTheDocument();

    fireEvent.click(more());
    const items = await screen.findAllByText('Remove provider');
    fireEvent.click(items[items.length - 1]);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBeGreaterThan(0));
    const oks = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(oks[oks.length - 1]);
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-custom-1')).not.toBeInTheDocument());
    expect(screen.getByTestId('mu-provider-editor')).toHaveTextContent('Relay');
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
  });

  it('removes a hand-written entry by name when saved; one that rerouted a built-in provider keeps the startup model', async () => {
    const base = settings();
    const foreign = [
      { id: 'anthropic', name: '', api: '', baseUrl: 'https://p.example.com', modelCount: 0 },
      { id: 'lab', name: 'Lab', api: 'bedrock-converse', baseUrl: '', modelCount: 2 },
    ];
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({
        models: { ...base.models, foreign, defaults: { provider: 'lab', model: 'x', thinkingLevel: '' } },
      }),
    });
    await open('models');
    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-lab'));
    fireEvent.click(within(screen.getByTestId('mu-provider-foreign')).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    expect(await screen.findByText(/this hand-written entry is deleted from models.json/)).toBeInTheDocument();
    expect(screen.getByText(/the default model is cleared too/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-foreign-lab')).not.toBeInTheDocument());
    expect(screen.getByTestId('mu-provider-item-foreign-anthropic')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.models?.removeEntries).toEqual(['lab']);
    expect(sent.models?.defaults.provider).toBe('');
  });

  it('keeps a removed id taken until the removal is saved, so a new provider cannot take over the old entry', async () => {
    await open('models');
    fireEvent.click(within(screen.getByTestId('mu-provider-editor')).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-custom-0')).not.toBeInTheDocument());
    fireEvent.click(screen.getByText('Add provider'));
    const editor = screen.getByTestId('mu-provider-editor');
    expect(within(editor).getByLabelText('ID')).not.toHaveValue('relay');
    fireEvent.change(within(editor).getByLabelText('ID'), { target: { value: 'relay' } });
    expect(editor).toHaveTextContent('already in use');
  });

  it('does not list a removed entry again from what mu last reported, nor offer it for the board', async () => {
    const base = settings();
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({
        models: {
          ...base.models,
          foreign: [{ id: 'lab-2', name: 'Lab 2', api: 'bedrock-converse', baseUrl: '', modelCount: 1 }],
        },
      }),
    });
    bridge.availableModels.mockResolvedValue({
      ok: true,
      data: { providers: [{ id: 'lab-2', models: [{ id: 'm', name: 'M' }] }], thinkingLevels: [] },
    });
    await open('models');
    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-lab-2'));
    fireEvent.click(within(screen.getByTestId('mu-provider-foreign')).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-foreign-lab-2')).not.toBeInTheDocument());
    expect(screen.queryByTestId('mu-provider-item-builtin-lab-2')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId('mu-board-model')).getByLabelText('Provider'));
    await waitFor(() => expect(document.querySelectorAll('.arco-select-option').length).toBeGreaterThan(0));
    const offered = [...document.querySelectorAll('.arco-select-option')].map((choice) => choice.textContent);
    // A custom provider is offered by its name, not its id.
    expect(offered).toContain('Relay');
    expect(offered).not.toContain('relay');
    expect(offered).not.toContain('lab-2');
    expect(offered).not.toContain('Lab 2');
  });

  it('shows Claude as usable through an API key when mu reported it and nobody is signed in', async () => {
    bridge.availableModels.mockResolvedValue({
      ok: true,
      data: { providers: [{ id: 'anthropic', models: [{ id: 'claude-x', name: 'Claude X' }] }], thinkingLevels: [] },
    });
    await open('models');
    const item = await screen.findByTestId('mu-provider-item-account-anthropic');
    await waitFor(() => expect(within(item).getByRole('img', { name: 'Usable (API key)' })).toBeInTheDocument());
    expect(screen.queryByTestId('mu-provider-item-builtin-anthropic')).not.toBeInTheDocument();
    fireEvent.click(item);
    const detail = screen.getByTestId('mu-account-anthropic');
    expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Usable (API key)');
    expect(detail).toHaveTextContent('its API key is in the environment');
    expect(detail).toHaveTextContent('Claude X');
    expect(within(detail).getByTestId('mu-account-signin-anthropic')).toBeInTheDocument();
  });

  it('shows a failed sign-in under its own subscription only, not under the one signed out next', async () => {
    bridge.loginStatus.mockResolvedValue({
      ok: true,
      data: { signedIn: [{ provider: 'anthropic', models: [] }] },
    });
    bridge.loginStart.mockResolvedValue({ ok: false, error: 'Timed out' });
    bridge.loginLogout.mockResolvedValue({ ok: true, data: { signedIn: [] } });
    await open('models');
    fireEvent.click(await screen.findByTestId('mu-provider-item-account-xai'));
    fireEvent.click(screen.getByTestId('mu-account-signin-xai'));
    await waitFor(() => expect(screen.getByTestId('mu-account-xai')).toHaveTextContent('Timed out'));

    fireEvent.click(screen.getByTestId('mu-provider-item-account-anthropic'));
    const claude = screen.getByTestId('mu-account-anthropic');
    await waitFor(() => expect(within(claude).getByTestId('mu-account-state')).toHaveTextContent('Signed in'));
    fireEvent.click(within(claude).getByTestId('mu-account-signout-anthropic'));
    const buttons = await screen.findAllByRole('button', { name: 'Sign out' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(bridge.loginLogout).toHaveBeenCalled());
    await waitFor(() => expect(within(claude).getByTestId('mu-account-state')).toHaveTextContent('Not signed in'));
    expect(claude).not.toHaveTextContent('Timed out');
  });

  it('opens a sign-in that is running, and points to it from another subscription', async () => {
    bridge.loginState.mockResolvedValue({
      ok: true,
      data: {
        id: 3,
        provider: 'xai',
        phase: 'running',
        url: 'https://accounts.x.ai/device',
        device: { userCode: 'ABCD-1234', verificationUri: 'https://accounts.x.ai/device' },
      },
    });
    await open('models');
    const grok = await screen.findByTestId('mu-account-xai');
    expect(within(grok).getByTestId('mu-login-waiting')).toHaveTextContent('ABCD-1234');
    fireEvent.click(screen.getByTestId('mu-provider-item-account-openai-codex'));
    expect(screen.getByTestId('mu-account-signin-openai-codex')).toBeDisabled();
    const hint = screen.getByTestId('mu-account-other');
    expect(hint).toHaveTextContent('Grok is signing in');
    fireEvent.click(within(hint).getByRole('button', { name: 'Show it' }));
    expect(screen.getByTestId('mu-account-xai')).toBeInTheDocument();
  });

  it('keeps the startup model when the removed entry only rerouted a built-in or subscription provider', async () => {
    const base = settings();
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({
        models: {
          ...base.models,
          foreign: [{ id: 'google-gemini-cli', name: '', api: '', baseUrl: 'https://g.example.com', modelCount: 0 }],
          defaults: { provider: 'google-gemini-cli', model: 'gemini-2.5-pro', thinkingLevel: '' },
        },
      }),
    });
    await open('models');
    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-google-gemini-cli'));
    fireEvent.click(within(screen.getByTestId('mu-provider-foreign')).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    await screen.findByText(/this hand-written entry is deleted from models.json/);
    expect(screen.queryByText(/the default model is cleared too/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.models?.removeEntries).toEqual(['google-gemini-cli']);
    expect(sent.models?.defaults.provider).toBe('google-gemini-cli');
  });

  it('leaves a startup model without a provider alone when a provider without an id is removed', async () => {
    const base = settings();
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({ models: { ...base.models, defaults: { provider: '', model: 'gpt-5', thinkingLevel: '' } } }),
    });
    await open('models');
    fireEvent.click(screen.getByText('Add provider'));
    const editor = screen.getByTestId('mu-provider-editor');
    fireEvent.change(within(editor).getByLabelText('ID'), { target: { value: '' } });
    fireEvent.click(within(editor).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-custom-1')).not.toBeInTheDocument());
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
  });

  it('shows hand-written and reported providers as they are, and locks editing when models.json has comments', async () => {
    const base = settings();
    const models = {
      ...base.models,
      commented: true,
      foreign: [{ id: 'anthropic', name: '', api: '', baseUrl: 'https://p.example.com', modelCount: 0 }],
    };
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ models }) });
    await open('models');
    expect(screen.getByText(/models.json contains comments/)).toBeInTheDocument();
    expect(screen.getByText('Add provider').closest('button')).toBeDisabled();
    expect(within(screen.getByTestId('mu-provider-editor')).getByTestId('mu-provider-more')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-anthropic'));
    const entry = screen.getByTestId('mu-provider-foreign');
    expect(entry).toHaveTextContent('can be removed here but not edited');
    expect(within(entry).getByTestId('mu-provider-more')).toBeDisabled();
    // A read-only model line still opens, to show what it leaves out.
    fireEvent.click(screen.getByTestId('mu-provider-item-custom-0'));
    fireEvent.click(screen.getByRole('button', { name: 'Show plain' }));
    expect(screen.getByLabelText('Max output 1')).toBeDisabled();
    fireEvent.click(await screen.findByTestId('mu-provider-item-builtin-corp-gateway'));
    const reported = screen.getByTestId('mu-provider-builtin');
    expect(reported).toHaveTextContent('cannot be removed here');
    expect(within(reported).queryByTestId('mu-provider-more')).not.toBeInTheDocument();
  });
});

describe('permissions', () => {
  /** Settings from a harness with permission modes and a board that can be told its model. */
  function withModes(patch: Partial<KyrnSettings> = {}): KyrnSettings {
    const parsed = parseManifest(withOwnPlaces(manifestJson));
    if (parsed.status !== 'ok') throw new Error('manifest with permission modes is not readable');
    const features = Object.fromEntries(
      parsed.manifest.features.map((feature) => [feature.name, defaultFeatureState(feature)])
    );
    return settings({ harness: parsed, features, ...patch });
  }

  it('sets the mode every new conversation starts in, full access included, and saves only that', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: withModes() });
    bridge.save.mockResolvedValue({
      ok: true,
      data: withModes({ revision: 'r2', permissions: { mode: 'full', from: 'picked' } }),
    });
    await open('permissions');
    const section = screen.getByTestId('mu-section-permissions');
    expect(
      within(section)
        .getAllByRole('radio')
        .map((tile) => tile.getAttribute('data-testid'))
    ).toEqual(['mu-permission-full', 'mu-permission-jev', 'mu-permission-ask']);
    expect(screen.getByTestId('mu-permission-full')).toHaveTextContent('Runs everything without asking');
    expect(screen.getByTestId('mu-permission-jev')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('mu-permission-full'));
    expect(screen.getByTestId('mu-permission-full')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Permissions');
    expect(within(screen.getByTestId('mu-nav-permissions')).getByLabelText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.permissions).toEqual({ mode: 'full' });
    // The feature itself is not touched: the pick has its own file.
    expect(sent.features?.permissions).toEqual(withModes().features.permissions);
    await waitFor(() => expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument());
    expect(screen.getByTestId('mu-permission-full')).toHaveAttribute('aria-checked', 'true');
  });

  it('says when this mu has no permission modes, and when they are off in the features', async () => {
    const { unmount } = render(<SettingsArea section='permissions' />, { wrapper });
    expect(await screen.findByTestId('mu-section-permissions')).toHaveTextContent(
      'This version of mu has no permission modes yet.'
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    unmount();
    const off = withModes();
    bridge.settings.mockResolvedValue({
      ok: true,
      data: { ...off, features: { ...off.features, permissions: { ...off.features.permissions, enabled: false } } },
    });
    render(<SettingsArea section='permissions' />, { wrapper });
    expect(await screen.findByTestId('mu-section-permissions')).toHaveTextContent(
      'Permission modes are off in Features'
    );
  });

  it('points from the features to where the mode and the board’s model are set', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: withModes() });
    await open('features');
    const permissions = screen.getByTestId('mu-feature-permissions');
    expect(permissions).toHaveTextContent('The mode of a new conversation is chosen under Permissions.');
    expect(within(permissions).queryByTestId('mu-option-permissions-mode')).not.toBeInTheDocument();
    const board = screen.getByTestId('mu-feature-board');
    expect(board).toHaveTextContent('The model that writes the board is chosen under Models & providers.');
    expect(within(board).queryByTestId('mu-option-board-model')).not.toBeInTheDocument();
    expect(within(board).getByTestId('mu-option-board-defaultOn')).toBeInTheDocument();
  });

  it('neither marks nor resets from the features an option set elsewhere', async () => {
    const base = withModes();
    const features = {
      ...base.features,
      permissions: { ...base.features.permissions, options: { mode: 'full' } },
      board: { ...base.features.board, options: { ...base.features.board.options, defaultOn: true, model: 'a/b' } },
    };
    bridge.settings.mockResolvedValue({ ok: true, data: { ...base, features } });
    await open('features');
    // mu.json's mode is shown under Permissions: nothing on this card differs from the default.
    const permissions = screen.getByTestId('mu-feature-permissions');
    expect(within(permissions).queryByTestId('mu-modified')).not.toBeInTheDocument();
    expect(within(permissions).queryByText('Restore defaults')).not.toBeInTheDocument();
    const board = screen.getByTestId('mu-feature-board');
    fireEvent.click(within(board).getByText('Restore defaults'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.features?.board.options).toMatchObject({ defaultOn: false, model: 'a/b' });
    expect(sent.features?.permissions.options).toEqual({ mode: 'full' });
  });

  it('draws the sections afresh on discard, so no field keeps a choice that was dropped', async () => {
    bridge.availableModels.mockResolvedValue({
      ok: true,
      data: { providers: [{ id: 'corp-gateway', models: [{ id: 'gpt-5', name: '' }] }], thinkingLevels: [] },
    });
    await open('models');
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId('mu-board-model')).getByLabelText('Provider'));
    fireEvent.click(await screen.findByText('corp-gateway', { selector: '.arco-select-option' }));
    await user.click(within(screen.getByTestId('mu-board-model')).getByLabelText('Model'));
    fireEvent.click(await screen.findByText('gpt-5', { selector: '.arco-select-option' }));
    expect(screen.getByTestId('mu-save-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Discard'));
    const card = screen.getByTestId('mu-board-model');
    expect(within(card).queryByText('corp-gateway')).not.toBeInTheDocument();
    expect(card).toHaveTextContent('Pick a provider first');
  });
});
