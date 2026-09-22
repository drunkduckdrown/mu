import { sameFeatureState, type HarnessManifest } from '@/common/kyrn/manifest';
import { providerKeyVariable, type ProviderSettings } from '@/common/kyrn/models';
import type { Credential, KyrnSettings, SaveSettings } from '@/common/kyrn/types';

/**
 * Models first: they are what a new user sets up; then how much mu may do without asking. The local judge is one of
 * the choices on the judges page.
 */
export const SECTIONS = ['models', 'permissions', 'judges', 'decisions', 'features', 'context'] as const;
export type SectionId = (typeof SECTIONS)[number];

/** What is being edited: a copy of the settings, plus keys typed but not saved. Keys only ever travel towards the store. */
export type Draft = {
  settings: KyrnSettings;
  /** Credential variable of a judge -> the key typed for it. */
  judgeKeys: Record<string, string>;
  /** Provider id -> the key typed for it. */
  providerKeys: Record<string, string>;
};

export const newDraft = (settings: KyrnSettings): Draft => ({ settings, judgeKeys: {}, providerKeys: {} });

/**
 * The settings as the page reads them. A main process older than this page sends no permission default and no board
 * model: without them the whole area would fail to draw; with these it shows that mu cannot be told.
 */
export const completeSettings = (settings: KyrnSettings): KyrnSettings => ({
  ...settings,
  permissions: settings.permissions ?? { mode: '', from: 'default' },
  boardModel: settings.boardModel ?? { supported: false, model: '' },
});

export function manifestOf(settings: KyrnSettings | undefined): HarnessManifest | undefined {
  return settings?.harness.status === 'ok' ? settings.harness.manifest : undefined;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const hasKeys = (keys: Record<string, string>): boolean => Object.values(keys).some(Boolean);

/** The editable part of a provider: what is read-only about it (key state, header names) never makes it "changed". */
const editableProvider = ({ id, name, api, baseUrl, authHeader, models }: ProviderSettings) => ({
  id,
  name,
  api,
  baseUrl,
  authHeader,
  models: models.map(({ thinkingLevels: _levels, ...model }) => model),
});

/** Sections with unsaved changes, for the dots in the section list and the text of the save bar. */
export function dirtySections(base: KyrnSettings, draft: Draft): Set<SectionId> {
  const next = draft.settings;
  const manifest = manifestOf(base);
  const dirty = new Set<SectionId>();
  if (!same(base.tiers, next.tiers) || !same(base.judges, next.judges) || hasKeys(draft.judgeKeys)) dirty.add('judges');
  if (base.mode !== next.mode || !same(base.decisionModes, next.decisionModes)) dirty.add('decisions');
  if (
    manifest?.features.some(
      (feature) => !sameFeatureState(feature, base.features[feature.name], next.features[feature.name])
    )
  )
    dirty.add('features');
  if (
    !same(base.models.providers.map(editableProvider), next.models.providers.map(editableProvider)) ||
    !same(base.models.defaults, next.models.defaults) ||
    base.boardModel.model !== next.boardModel.model ||
    removedEntries(base, draft).length > 0 ||
    hasKeys(draft.providerKeys)
  )
    dirty.add('models');
  if (base.permissions.mode !== next.permissions.mode) dirty.add('permissions');
  if (
    base.autoCompaction !== next.autoCompaction ||
    base.maxContextTokens !== next.maxContextTokens ||
    base.betaCompression !== next.betaCompression
  )
    dirty.add('context');
  return dirty;
}

/** Hand-written models.json entries that were there when the settings were read, and are removed in the draft. */
export function removedEntries(base: KyrnSettings, draft: Draft): string[] {
  const kept = new Set(draft.settings.models.foreign.map((entry) => entry.id));
  return base.models.foreign.map((entry) => entry.id).filter((id) => !kept.has(id));
}

/**
 * The one payload of the save bar. Everything is validated again by the store, which is the authority. `base`, the
 * settings the draft was made from, says which hand-written entries were removed.
 */
export function toSave(draft: Draft, base?: KyrnSettings): SaveSettings {
  const { keys: _keys, harness, decisionModes, features, models, permissions, boardModel, ...rest } = draft.settings;
  const removeEntries = base ? removedEntries(base, draft) : [];
  const credentials: Credential[] = [
    ...Object.entries(draft.judgeKeys).map(([name, value]) => ({ name, value })),
    ...Object.entries(draft.providerKeys)
      .filter(([id]) => models.providers.some((provider) => provider.id === id))
      .map(([id, value]) => ({ name: providerKeyVariable(id), value })),
  ].filter((credential) => credential.value);
  return {
    ...rest,
    ...(harness.status === 'ok' ? { decisionModes, features } : {}),
    models: {
      providers: models.providers,
      defaults: models.defaults,
      ...(removeEntries.length ? { removeEntries } : {}),
    },
    ...(credentials.length ? { credentials } : {}),
    ...(permissions.mode ? { permissions: { mode: permissions.mode } } : {}),
    ...(boardModel.supported ? { boardModel: { model: boardModel.model } } : {}),
  };
}

/**
 * The old beta switch and `features.compaction.enabled` are one thing shown in two sections.
 * Whichever is flipped, both follow, so the store never sees them disagree.
 */
export function setCompaction(settings: KyrnSettings, enabled: boolean): KyrnSettings {
  const compaction = settings.features.compaction;
  return {
    ...settings,
    betaCompression: enabled,
    features: compaction ? { ...settings.features, compaction: { ...compaction, enabled } } : settings.features,
  };
}

/** Case-insensitive search over whatever texts describe an entry. An empty query matches everything. */
export function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = texts.filter(Boolean).join('\n').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** A stale revision is the one failure with a remedy of its own: load again. The store says so by its code. */
export const isStale = (error: { code: string }): boolean => error.code === 'stale';
