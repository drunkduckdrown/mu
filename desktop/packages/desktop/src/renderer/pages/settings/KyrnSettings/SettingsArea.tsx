import React, { useState } from 'react';
import { Alert, Button, Message, Spin } from '@arco-design/web-react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { formatNameList } from '@/renderer/services/i18n/list';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { SECTIONS, manifestOf, type SectionId } from './draft';
import MuErrorMessage from './fields/MuErrorMessage';
import ContextSection from './sections/ContextSection';
import DecisionsSection from './sections/DecisionsSection';
import FeaturesSection from './sections/FeaturesSection';
import JudgesSection from './sections/JudgesSection';
import ModelsSection from './sections/ModelsSection';
import PermissionsSection from './sections/PermissionsSection';
import { useMuSettings } from './useMuSettings';
import styles from './SettingsArea.module.css';

/**
 * Everything mu can be told: models and providers, permissions, judges, decision points, features, context. Sections share one
 * draft and one save, because the files behind them share one revision.
 *
 * In the settings page the section comes from the route and the settings navigation lists the sections itself, so
 * there is no second menu and no second title here. The settings modal passes no section and gets the section list.
 */
export default function SettingsArea({ section: routed }: { section?: SectionId } = {}) {
  const { t, i18n } = useTranslation();
  const mu = useMuSettings();
  // The hook form needs no global React adapter, unlike the static Message.
  const [message, messageHolder] = Message.useMessage();
  const [picked, setSection] = useState<SectionId>('models');
  const section = routed ?? picked;
  // One query for decisions and features: what you look for is usually in both.
  const [query, setQuery] = useState('');
  const { base, draft, dirty, error } = mu;
  const manifest = manifestOf(base);

  const save = async () => {
    if (await mu.save()) message.success?.(t('mu.save.saved'));
  };

  let content: React.ReactNode = null;
  if (base && draft) {
    const { settings } = draft;
    if (section === 'judges')
      content = (
        <JudgesSection
          draft={draft}
          base={base}
          onChange={mu.editSettings}
          onKey={(variable, value) =>
            mu.edit((now) => ({ ...now, judgeKeys: { ...now.judgeKeys, [variable]: value } }))
          }
        />
      );
    else if (section === 'decisions')
      content = (
        <DecisionsSection
          settings={settings}
          manifest={manifest}
          query={query}
          onQuery={setQuery}
          onChange={mu.editSettings}
        />
      );
    else if (section === 'features')
      content = (
        <FeaturesSection
          settings={settings}
          manifest={manifest}
          query={query}
          onQuery={setQuery}
          onChange={mu.editSettings}
        />
      );
    else if (section === 'models')
      content = <ModelsSection draft={draft} base={base} available={mu.available} onDraft={mu.edit} />;
    else if (section === 'permissions')
      content = <PermissionsSection settings={settings} manifest={manifest} onChange={mu.editSettings} />;
    else content = <ContextSection settings={settings} base={base} onChange={mu.editSettings} />;
  }

  return (
    <div className={styles.area} data-testid='kyrn-settings'>
      {messageHolder}
      {/* Not sticky: the section list is what stays in view here. */}
      {routed ? null : <SettingsPageHeader sticky={false} title={t('mu.title')} description={t('mu.description')} />}
      {base?.harness.status === 'unsupported' ? (
        <Alert type='warning' content={t('mu.harness.unsupported', { version: base.harness.version })} />
      ) : null}
      {!base || !draft ? (
        error ? (
          <Alert
            type='error'
            title={t('mu.load.failed')}
            content={<MuErrorMessage error={error} />}
            action={<Button onClick={mu.reload}>{t('mu.reload')}</Button>}
          />
        ) : (
          <Spin />
        )
      ) : (
        <div className={classNames(styles.body, routed && styles.bodyRouted)}>
          {routed ? null : (
            <div className={styles.nav} role='tablist' aria-label={t('mu.title')}>
              {SECTIONS.map((id) => (
                <div
                  key={id}
                  role='tab'
                  tabIndex={0}
                  aria-selected={section === id}
                  data-testid={`mu-nav-${id}`}
                  className={classNames(styles.navItem, section === id && styles.navItemActive)}
                  onClick={() => setSection(id)}
                  onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && setSection(id)}
                >
                  <span className={styles.navLabel}>{t(`mu.sections.${id}`)}</span>
                  {dirty.has(id) ? <span className={styles.dot} aria-label={t('mu.save.unsavedDot')} /> : null}
                </div>
              ))}
            </div>
          )}
          <div className={styles.content} role={routed ? undefined : 'tabpanel'}>
            <React.Fragment key={mu.generation}>{content}</React.Fragment>
            <div className={styles.note}>{t('mu.applyNote')}</div>
            {dirty.size || error ? (
              <div className={styles.saveBar} data-testid='mu-save-bar'>
                <span className={styles.saveText}>
                  {dirty.size
                    ? t('mu.save.unsaved', {
                        sections: formatNameList(
                          [...dirty].map((id) => t(`mu.sections.${id}`)),
                          i18n.language
                        ),
                      })
                    : t('mu.save.nothing')}
                </span>
                {error?.stale ? (
                  <Button size='small' onClick={mu.reload}>
                    {t('mu.reload')}
                  </Button>
                ) : null}
                <Button size='small' disabled={mu.saving || !dirty.size} onClick={mu.discard}>
                  {t('mu.save.discard')}
                </Button>
                <Button
                  size='small'
                  type='primary'
                  loading={mu.saving}
                  disabled={!dirty.size}
                  onClick={() => void save()}
                >
                  {t('common.save')}
                </Button>
                {error ? (
                  <div className={styles.saveError} role='alert'>
                    {error.stale ? (
                      t('mu.save.stale')
                    ) : (
                      <MuErrorMessage
                        error={error}
                        manifest={manifest}
                        frame={(reason) => t('mu.save.failed', { reason })}
                      />
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
