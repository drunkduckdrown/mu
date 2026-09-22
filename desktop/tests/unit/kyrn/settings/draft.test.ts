import { describe, expect, it } from 'vitest';
import { defaultFeatureState, parseManifest } from '../../../../packages/desktop/src/common/kyrn/manifest';
import type { KyrnSettings } from '../../../../packages/desktop/src/common/kyrn/types';
import {
  dirtySections,
  isStale,
  matches,
  newDraft,
  setCompaction,
  toSave,
} from '../../../../packages/desktop/src/renderer/pages/settings/KyrnSettings/draft';
import {
  blankProvider,
  freeProviderId,
  providerProblems,
} from '../../../../packages/desktop/src/renderer/pages/settings/KyrnSettings/providers/endpoints';
import manifestJson from './manifest.fixture.json';

const harness = parseManifest(manifestJson);
if (harness.status !== 'ok') throw new Error('fixture manifest is not readable');

const base: KyrnSettings = {
  revision: 'r1',
  tiers: ['jev'],
  judges: { jev: { type: 'jev', model: '', baseUrl: '', apiKeyEnv: 'TYPESAFE_API_KEY', timeoutMs: 10000 } },
  mode: 'shadow',
  betaCompression: false,
  autoCompaction: true,
  maxContextTokens: 0,
  keys: { TYPESAFE_API_KEY: false },
  harness,
  decisionModes: {},
  features: Object.fromEntries(
    harness.manifest.features.map((feature) => [feature.name, defaultFeatureState(feature)])
  ),
  models: {
    providers: [
      {
        ...blankProvider('relay'),
        isNew: undefined,
        baseUrl: 'https://relay.example.com/v1',
        key: 'managed',
        keySet: true,
      },
    ],
    foreign: [],
    defaults: { provider: '', model: '', thinkingLevel: '' },
    commented: false,
    problem: '',
  },
  permissions: { mode: 'jev', from: 'default' },
  boardModel: { supported: true, model: '' },
};

const entry = (id: string) => ({ id, name: '', api: '', baseUrl: '', modelCount: 0 });

describe('the draft of the settings area', () => {
  it('is clean when nothing was edited, whatever is read-only about a provider', () => {
    const draft = newDraft(structuredClone(base));
    draft.settings.models.providers[0].keySet = false;
    draft.settings.models.providers[0].headerNames = ['x'];
    expect([...dirtySections(base, draft)]).toEqual([]);
  });
  it('names each section that was edited, and a typed key counts', () => {
    const edited = structuredClone(base);
    edited.decisionModes = { 'tool.risk': 'off' };
    edited.features.guard.enabled = false;
    edited.maxContextTokens = 64000;
    expect([...dirtySections(base, newDraft(edited))]).toEqual(['decisions', 'features', 'context']);
    expect([...dirtySections(base, { ...newDraft(base), judgeKeys: { TYPESAFE_API_KEY: 'k' } })]).toEqual(['judges']);
    expect([...dirtySections(base, { ...newDraft(base), providerKeys: { relay: 'k' } })]).toEqual(['models']);
    expect([...dirtySections(base, { ...newDraft(base), providerKeys: { relay: '' } })]).toEqual([]);
  });
  it('sends keys as credentials under the variable of their provider, and nothing read-only', () => {
    const sent = toSave({
      settings: base,
      judgeKeys: { TYPESAFE_API_KEY: 'judge' },
      providerKeys: { relay: 'sk', gone: 'x' },
    });
    expect(sent.credentials).toEqual([
      { name: 'TYPESAFE_API_KEY', value: 'judge' },
      { name: 'MU_PROVIDER_RELAY_API_KEY', value: 'sk' },
    ]);
    expect(Object.keys(sent)).not.toEqual(expect.arrayContaining(['keys', 'harness']));
    expect(Object.keys(sent.models ?? {})).toEqual(['providers', 'defaults']);
    const old = toSave(newDraft({ ...base, harness: { status: 'missing' }, features: {} }));
    expect(old).not.toHaveProperty('features');
  });
  it('counts a removed hand-written entry as a change, and names it for the store only against the base', () => {
    const read = { ...base, models: { ...base.models, foreign: [entry('lab'), entry('anthropic')] } };
    const draft = newDraft({ ...read, models: { ...read.models, foreign: [entry('anthropic')] } });
    expect([...dirtySections(read, draft)]).toEqual(['models']);
    expect(toSave(draft, read).models?.removeEntries).toEqual(['lab']);
    expect(toSave(newDraft(read), read).models).not.toHaveProperty('removeEntries');
    // Without the base nothing is known to be removed, so nothing is.
    expect(toSave(draft).models).not.toHaveProperty('removeEntries');
  });
  it('keeps the beta switch and the compaction feature as one', () => {
    const on = setCompaction(base, true);
    expect([on.betaCompression, on.features.compaction.enabled]).toEqual([true, true]);
    expect(setCompaction({ ...base, features: {} }, true).betaCompression).toBe(true);
  });
  it('searches every word, in any of the texts, ignoring case', () => {
    expect(matches('', 'anything')).toBe(true);
    expect(matches('HIVE deliver', 'hive.deliver', '蜂群：投递')).toBe(true);
    expect(matches('蜂群 risk', 'hive.deliver', '蜂群：投递')).toBe(false);
    // A stale revision is recognised by the store's code, not by its English words.
    expect(isStale({ code: 'stale' })).toBe(true);
    expect(isStale({ code: 'unknown' })).toBe(false);
  });
});

describe('provider form rules', () => {
  it('explains an id, an address and model ids the store would refuse', () => {
    const provider = { ...blankProvider('Bad Id'), baseUrl: 'http://example.com/v1', models: [] };
    expect(providerProblems(provider, true, new Set())).toEqual({ id: 'format', baseUrl: 'unsafe' });
    expect(providerProblems({ ...provider, id: 'openai' }, true, new Set()).id).toBe('reserved');
    expect(providerProblems({ ...provider, id: 'mine' }, true, new Set(['mine'])).id).toBe('taken');
    // A saved provider keeps whatever id it has.
    expect(providerProblems({ ...provider, baseUrl: '' }, false, new Set())).toEqual({ baseUrl: 'empty' });
    const model = {
      id: 'a',
      name: '',
      reasoning: false,
      imageInput: false,
      contextWindow: 1,
      maxTokens: 1,
      thinkingLevels: [],
    };
    const ok = { ...provider, id: 'mine', baseUrl: 'http://localhost:1234/v1' };
    expect(providerProblems({ ...ok, models: [model, model] }, true, new Set()).models).toBe('duplicate');
    expect(providerProblems({ ...ok, models: [{ ...model, id: ' ' }] }, true, new Set()).models).toBe('emptyId');
    expect(providerProblems({ ...ok, models: [model] }, true, new Set())).toEqual({});
  });
  it('finds a free id', () => {
    expect(freeProviderId(new Set())).toBe('custom');
    expect(freeProviderId(new Set(['custom', 'custom-2']))).toBe('custom-3');
  });
});
