import React from 'react';
import { Alert } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { localized, type HarnessManifest } from '@/common/kyrn/manifest';
import type { KyrnSettings } from '@/common/kyrn/types';
import ChoiceTile from '../fields/ChoiceTile';
import SectionShell from './SectionShell';
import styles from './sections.module.css';

/** The modes the app words itself; another one a newer mu offers goes by the manifest's name for it. */
const WORDED = new Set(['full', 'jev', 'ask']);

type PermissionsSectionProps = {
  settings: KyrnSettings;
  manifest?: HarnessManifest;
  onChange: (change: (settings: KyrnSettings) => KyrnSettings) => void;
};

/**
 * How much mu may do without asking, for every new conversation: full access, JeV approving for you, or asking before
 * anything but reading. A conversation that is already open keeps its own mode, switched from its send box.
 */
export default function PermissionsSection({ settings, manifest, onChange }: PermissionsSectionProps) {
  const { t, i18n } = useTranslation();
  const option = manifest?.features
    .find((feature) => feature.name === 'permissions')
    ?.options.find((each) => each.key === 'mode');
  const choices = option?.kind === 'choice' ? option.choices : [];
  const current = settings.permissions.mode;
  const off = settings.features.permissions?.enabled === false;

  return (
    <SectionShell id='permissions' title={t('mu.sections.permissions')} description={t('mu.permissions.description')}>
      {!choices.length ? (
        <Alert type='warning' content={t('mu.permissions.missing')} />
      ) : (
        <>
          {off ? <Alert type='warning' content={t('mu.permissions.off')} /> : null}
          <div className={styles.choices} role='radiogroup' aria-label={t('mu.permissions.choose')}>
            {choices.map(({ value, label }) => (
              <ChoiceTile
                key={value}
                testId={`mu-permission-${value}`}
                title={WORDED.has(value) ? t(`mu.permissions.modes.${value}.title`) : localized(label, i18n.language)}
                description={WORDED.has(value) ? t(`mu.permissions.modes.${value}.description`) : undefined}
                active={current === value}
                onPick={() => onChange((now) => ({ ...now, permissions: { mode: value, from: 'picked' } }))}
              />
            ))}
          </div>
          <div className={styles.choiceHint}>{t('mu.permissions.note')}</div>
        </>
      )}
    </SectionShell>
  );
}
