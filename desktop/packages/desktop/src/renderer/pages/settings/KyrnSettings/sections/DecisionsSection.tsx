import React from 'react';
import { Alert, Input, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import {
  localized,
  localizedTexts,
  type DecisionMode,
  type HarnessManifest,
  type Localized,
} from '@/common/kyrn/manifest';
import type { KyrnSettings } from '@/common/kyrn/types';
import { matches } from '../draft';
import ModeControl, { useModeLabels } from '../fields/ModeControl';
import Row from '../fields/Row';
import SectionShell, { Card, GroupTitle } from './SectionShell';
import styles from './sections.module.css';

/** The harness's own default for `modes.default` (its config.ts). */
const HARNESS_DEFAULT_MODE: DecisionMode = 'shadow';
/** Groups the desktop has words for, should a manifest list decisions under one without naming it. */
const KNOWN_GROUPS = new Set(['input', 'context', 'tools', 'turn', 'team']);

type DecisionsSectionProps = {
  settings: KyrnSettings;
  manifest?: HarnessManifest;
  query: string;
  onQuery: (query: string) => void;
  onChange: (change: (settings: KyrnSettings) => KyrnSettings) => void;
};

/** Every decision point the harness declares, grouped as the manifest groups them, each with its own mode. */
export default function DecisionsSection({ settings, manifest, query, onQuery, onChange }: DecisionsSectionProps) {
  const { t, i18n } = useTranslation();
  const labels = useModeLabels(manifest);
  const say = (text?: Localized) => localized(text, i18n.language);
  const groupTitle = (group: string): string =>
    say(manifest?.groups[group]) ||
    (KNOWN_GROUPS.has(group) ? t(`mu.decisions.groups.${group}`) : t('mu.decisions.otherGroup'));

  const setMode = (id: string, mode: DecisionMode | undefined) =>
    onChange((now) => {
      const { [id]: _removed, ...rest } = now.decisionModes;
      return { ...now, decisionModes: mode ? { ...rest, [id]: mode } : rest };
    });

  const features = new Map(manifest?.features.map((feature) => [feature.name, feature]));
  const shown = (manifest?.decisions ?? []).filter((decision) => {
    const feature = features.get(decision.feature);
    // Every language is searched: an id or an English word finds its entry in a Chinese screen too.
    return matches(
      query,
      decision.id,
      ...localizedTexts(decision.title),
      ...localizedTexts(decision.summary),
      ...localizedTexts(feature?.title)
    );
  });
  const groups = [...new Set([...Object.keys(manifest?.groups ?? {}), ...shown.map((decision) => decision.group)])];

  return (
    <SectionShell
      id='decisions'
      title={t('mu.sections.decisions')}
      description={t('mu.decisions.description')}
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
      <Card>
        <Row
          testId='mu-default-mode'
          title={t('mu.decisions.defaultMode')}
          help={
            // Two sentences from two sources (the app, the harness): each its own line, never glued together.
            <>
              <div>{t('mu.decisions.defaultModeHelp')}</div>
              <div>{labels[settings.mode].help}</div>
            </>
          }
          modified={settings.mode !== HARNESS_DEFAULT_MODE}
        >
          <ModeControl
            label={t('mu.decisions.defaultMode')}
            labels={labels}
            value={settings.mode}
            onChange={(mode) => mode && onChange((now) => ({ ...now, mode }))}
          />
        </Row>
      </Card>
      {!manifest ? <Alert type='warning' content={t('mu.harness.tooOld')} /> : null}
      {groups.map((group) => {
        const rows = shown.filter((decision) => decision.group === group);
        if (!rows.length) return null;
        return (
          <React.Fragment key={group}>
            <GroupTitle>{groupTitle(group)}</GroupTitle>
            <Card testId={`mu-decision-group-${group}`}>
              {rows.map((decision) => {
                const feature = features.get(decision.feature);
                const off = settings.features[decision.feature]?.enabled === false;
                return (
                  <Row
                    key={decision.id}
                    testId={`mu-decision-${decision.id}`}
                    title={
                      <>
                        {say(decision.title)} <span className={styles.mono}>{decision.id}</span>
                      </>
                    }
                    help={say(decision.summary)}
                    modified={decision.id in settings.decisionModes}
                    badges={
                      <>
                        <Tag size='small'>
                          {t('mu.decisions.feature', { name: say(feature?.title) || decision.feature })}
                        </Tag>
                        {off ? (
                          <Tag size='small' color='orange'>
                            {t('mu.decisions.featureOff')}
                          </Tag>
                        ) : null}
                      </>
                    }
                  >
                    <ModeControl
                      label={say(decision.title)}
                      labels={labels}
                      followDefault={settings.mode}
                      value={settings.decisionModes[decision.id]}
                      onChange={(mode) => setMode(decision.id, mode)}
                    />
                  </Row>
                );
              })}
            </Card>
          </React.Fragment>
        );
      })}
      {manifest && !shown.length ? <div className={styles.empty}>{t('mu.noMatch')}</div> : null}
    </SectionShell>
  );
}
