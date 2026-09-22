import React from 'react';
import { Alert, Button, Input, Switch, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import {
  defaultFeatureState,
  isDefaultFeatureState,
  localized,
  localizedTexts,
  type FeatureInfo,
  type FeatureState,
  type HarnessManifest,
  type Localized,
} from '@/common/kyrn/manifest';
import type { KyrnSettings } from '@/common/kyrn/types';
import { formatNameList } from '@/renderer/services/i18n/list';
import { matches, setCompaction } from '../draft';
import OptionField from '../fields/OptionField';
import { ModifiedMark } from '../fields/Row';
import SectionShell, { Card } from './SectionShell';
import styles from './sections.module.css';

/** Options that have a place of their own in the settings, by feature, with the sentence that points there. */
const ELSEWHERE: Record<string, { key: string; where: string }> = {
  permissions: { key: 'mode', where: 'mu.features.permissionsElsewhere' },
  board: { key: 'model', where: 'mu.features.boardModelElsewhere' },
};

type FeaturesSectionProps = {
  settings: KyrnSettings;
  manifest?: HarnessManifest;
  query: string;
  onQuery: (query: string) => void;
  onChange: (change: (settings: KyrnSettings) => KyrnSettings) => void;
};

/** Every feature the harness describes: its switch, and its options drawn generically by kind. */
export default function FeaturesSection({ settings, manifest, query, onQuery, onChange }: FeaturesSectionProps) {
  const { t, i18n } = useTranslation();
  const say = (text?: Localized) => localized(text, i18n.language);

  const setFeature = (feature: FeatureInfo, state: FeatureState) =>
    onChange((now) => {
      const next = { ...now, features: { ...now.features, [feature.name]: state } };
      // The context section shows this one switch too.
      return feature.name === 'compaction' ? setCompaction(next, state.enabled) : next;
    });

  const shown = (manifest?.features ?? []).filter((feature) =>
    matches(
      query,
      feature.name,
      ...localizedTexts(feature.title),
      ...localizedTexts(feature.summary),
      ...feature.options.flatMap((option) => [option.key, ...localizedTexts(option.label)])
    )
  );

  return (
    <SectionShell
      id='features'
      title={t('mu.sections.features')}
      description={t('mu.features.description')}
      actions={
        manifest ? (
          <Input.Search
            allowClear
            size='small'
            className={styles.search}
            aria-label={t('mu.search')}
            placeholder={t('mu.search')}
            value={query}
            onChange={onQuery}
          />
        ) : null
      }
    >
      {!manifest ? <Alert type='warning' content={t('mu.harness.tooOld')} /> : null}
      {shown.map((feature) => {
        const state = settings.features[feature.name] ?? defaultFeatureState(feature);
        const asks = manifest?.decisions.filter((decision) => decision.feature === feature.name) ?? [];
        const elsewhere = ELSEWHERE[feature.name];
        const options = feature.options.filter((option) => option.key !== elsewhere?.key);
        // An option set elsewhere is neither "modified" here nor reset from here: it is not on this card.
        const modified = !isDefaultFeatureState({ ...feature, options }, state);
        const reset = (): FeatureState => {
          const next = defaultFeatureState(feature);
          if (elsewhere && elsewhere.key in state.options) next.options[elsewhere.key] = state.options[elsewhere.key];
          return next;
        };
        return (
          <Card
            key={feature.name}
            testId={`mu-feature-${feature.name}`}
            title={
              <>
                {say(feature.title)} <span className={styles.mono}>{feature.name}</span>
              </>
            }
            badges={
              <>
                {feature.beta ? (
                  <Tag size='small' color='purple'>
                    {t('mu.features.beta')}
                  </Tag>
                ) : null}
                <ModifiedMark show={modified} />
              </>
            }
            extra={
              <>
                {modified ? (
                  <Button size='mini' type='text' onClick={() => setFeature(feature, reset())}>
                    {t('mu.features.reset')}
                  </Button>
                ) : null}
                <Switch
                  size='small'
                  aria-label={say(feature.title)}
                  checked={state.enabled}
                  onChange={(enabled) => setFeature(feature, { ...state, enabled })}
                />
              </>
            }
            summary={
              // The harness's summary and the app's sentence about it are separate lines, not one glued sentence.
              <>
                <div>{say(feature.summary)}</div>
                {asks.length ? (
                  <div>
                    {t('mu.features.asks', {
                      names: formatNameList(
                        asks.map((decision) => say(decision.title)),
                        i18n.language
                      ),
                    })}
                  </div>
                ) : null}
                {elsewhere && options.length < feature.options.length ? <div>{t(elsewhere.where)}</div> : null}
              </>
            }
            dim={!state.enabled}
          >
            {options.map((option) => (
              <OptionField
                key={option.key}
                scope={feature.name}
                option={option}
                value={state.options[option.key]}
                onChange={(value) =>
                  setFeature(feature, { ...state, options: { ...state.options, [option.key]: value } })
                }
              />
            ))}
          </Card>
        );
      })}
      {manifest && !shown.length ? <div className={styles.empty}>{t('mu.noMatch')}</div> : null}
    </SectionShell>
  );
}
