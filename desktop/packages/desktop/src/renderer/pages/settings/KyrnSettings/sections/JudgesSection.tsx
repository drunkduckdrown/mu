import React, { useState } from 'react';
import { Input, InputNumber, Radio, Tag } from '@arco-design/web-react';
import { Down, Up } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import AionSelect from '@/renderer/components/base/AionSelect';
import { formatNumber } from '@/renderer/services/i18n/format';
import type { JudgeSettings, JudgeType, KyrnSettings } from '@/common/kyrn/types';
import type { Draft } from '../draft';
import ChoiceTile from '../fields/ChoiceTile';
import Row from '../fields/Row';
import fieldStyles from '../fields/fields.module.css';
import { choiceOf, choose, JUDGE_CHOICES, type JudgeChoice, jevKeyVariable, profileFor } from '../judgeChoice';
import SectionShell, { Card } from './SectionShell';
import LocalJudgePanel from './LocalJudgePanel';
import styles from './sections.module.css';

const JUDGE_TYPES: JudgeType[] = ['jev', 'typesafe', 'gateway', 'local', 'http', 'llm', 'mock'];
/** The judge timeout the store accepts, in milliseconds. */
const TIMEOUT_MIN = 100;
const TIMEOUT_MAX = 120000;

type JudgesSectionProps = {
  draft: Draft;
  base: KyrnSettings;
  onChange: (change: (settings: KyrnSettings) => KyrnSettings) => void;
  onKey: (variable: string, value: string) => void;
};

/**
 * Which judge answers the small questions mu asks while it works. One choice, and under it the one thing that
 * choice needs; the order of several judges and every field of every profile are the advanced view.
 */
export default function JudgesSection({ draft, base, onChange, onKey }: JudgesSectionProps) {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  const { settings } = draft;
  const current = choiceOf(settings);

  return (
    <SectionShell id='judges' title={t('mu.sections.judges')} description={t('mu.judges.intro')}>
      <div className={styles.choices} role='radiogroup' aria-label={t('mu.judges.choose')}>
        {JUDGE_CHOICES.map((choice) => (
          <JudgeChoiceTile
            key={choice}
            choice={choice}
            active={current === choice}
            onPick={() => onChange((now) => choose(now, choice))}
          >
            {current === choice ? <ChoiceBody choice={choice} draft={draft} onKey={onKey} /> : null}
          </JudgeChoiceTile>
        ))}
      </div>
      {current === undefined ? <div className={styles.meta}>{t('mu.judges.custom')}</div> : null}
      <button
        type='button'
        className={styles.advancedToggle}
        aria-expanded={advanced}
        data-testid='mu-judges-advanced'
        onClick={() => setAdvanced((open) => !open)}
      >
        {t('mu.judges.advanced')}
        {advanced ? <Up theme='outline' size='14' /> : <Down theme='outline' size='14' />}
      </button>
      {advanced ? <AdvancedJudges draft={draft} base={base} onChange={onChange} onKey={onKey} /> : null}
    </SectionShell>
  );
}

type TileProps = { choice: JudgeChoice; active: boolean; onPick: () => void; children?: React.ReactNode };

/** One of the three judge choices, worded from the mu i18n module. */
export function JudgeChoiceTile({ choice, active, onPick, children }: TileProps) {
  const { t } = useTranslation();
  return (
    <ChoiceTile
      testId={`mu-judge-choice-${choice}`}
      title={t(`mu.judges.choices.${choice}.title`)}
      tag={t(`mu.judges.choices.${choice}.tag`)}
      description={t(`mu.judges.choices.${choice}.description`)}
      active={active}
      onPick={onPick}
    >
      {children}
    </ChoiceTile>
  );
}

type BodyProps = {
  choice: JudgeChoice;
  draft: Draft;
  onKey: JudgesSectionProps['onKey'];
};

/** The one thing a choice needs: Jev a key, Laya to be installed and running (one click each). */
export function ChoiceBody({ choice, draft, onKey }: BodyProps) {
  const { t } = useTranslation();
  const { settings } = draft;
  const name = profileFor(settings, choice);
  const judge = name ? settings.judges[name] : undefined;

  if (choice === 'jev') {
    const variable = jevKeyVariable(judge);
    const set = settings.keys[variable];
    return (
      <div className={styles.choiceField}>
        <label className={styles.choiceLabel}>
          {t('mu.apiKey')}
          <Tag size='small' color={set ? 'green' : undefined}>
            {t(set ? 'mu.keyState.set' : 'mu.keyState.none')}
          </Tag>
        </label>
        <Input.Password
          className={styles.choiceInput}
          aria-label={t('mu.apiKey')}
          autoComplete='new-password'
          value={draft.judgeKeys[variable] ?? ''}
          placeholder={set ? t('mu.keyKeep') : t('mu.judges.keyPlaceholder')}
          onChange={(value) => onKey(variable, value)}
        />
        <div className={styles.choiceHint}>{t('mu.keyHelp')}</div>
      </div>
    );
  }

  return (
    <div className={styles.choiceField}>
      <LocalJudgePanel />
      <div className={styles.choiceHint}>
        {t('mu.judges.localAddress', { address: judge?.baseUrl || t('mu.judges.endpointDefault') })}
      </div>
    </div>
  );
}

type AdvancedProps = JudgesSectionProps;

/** The order of the judges, and every field of every profile: what the simple view decides for you. */
function AdvancedJudges({ draft, base, onChange, onKey }: AdvancedProps) {
  const { t, i18n } = useTranslation();
  const { settings } = draft;
  const names = Object.keys(settings.judges);
  const [picked, setPicked] = useState(settings.tiers[0]);
  const selected = picked in settings.judges ? picked : names[0];
  const judge = settings.judges[selected];
  const update = (patch: Partial<JudgeSettings>) =>
    onChange((now) => ({ ...now, judges: { ...now.judges, [selected]: { ...now.judges[selected], ...patch } } }));
  const before = base.judges[selected];
  const changed = (key: keyof JudgeSettings) => before !== undefined && before[key] !== judge[key];

  return (
    <div className={styles.advanced} data-testid='mu-judges-advanced-body'>
      <Card title={t('mu.judges.tiers')} summary={t('mu.judges.tiersHelp')}>
        <Row
          title={t('mu.judges.order')}
          help={settings.tiers.join(' → ')}
          modified={base.tiers.join() !== settings.tiers.join()}
        >
          <AionSelect
            mode='multiple'
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.judges.order')}
            value={settings.tiers}
            onChange={(tiers: string[]) => tiers.length && onChange((now) => ({ ...now, tiers }))}
            options={names}
          />
        </Row>
      </Card>
      <Card
        title={t('mu.judges.judge')}
        extra={
          <Radio.Group
            type='button'
            size='small'
            aria-label={t('mu.judges.judge')}
            value={selected}
            options={names}
            onChange={setPicked}
          />
        }
      >
        <Row title={t('mu.judges.type')} help={t(`mu.judges.types.${judge.type}Help`)} modified={changed('type')}>
          <AionSelect
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.judges.type')}
            value={judge.type}
            onChange={(type: JudgeType) => update({ type })}
            options={JUDGE_TYPES.map((value) => ({ value, label: t(`mu.judges.types.${value}`) }))}
          />
        </Row>
        <Row title={t('mu.judges.model')} help={t('mu.judges.modelHelp')} modified={changed('model')}>
          <Input
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.judges.model')}
            value={judge.model}
            onChange={(model) => update({ model })}
          />
        </Row>
        <Row title={t('mu.judges.endpoint')} help={t('mu.endpointRule')} modified={changed('baseUrl')}>
          <Input
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.judges.endpoint')}
            value={judge.baseUrl}
            placeholder={t('mu.judges.endpointDefault')}
            onChange={(baseUrl) => update({ baseUrl })}
          />
        </Row>
        <Row
          title={t('mu.judges.timeout')}
          help={t('mu.options.range', {
            min: formatNumber(TIMEOUT_MIN, i18n.language),
            max: formatNumber(TIMEOUT_MAX, i18n.language),
          })}
          modified={changed('timeoutMs')}
        >
          <InputNumber
            size='small'
            className={fieldStyles.number}
            aria-label={t('mu.judges.timeout')}
            value={judge.timeoutMs}
            min={TIMEOUT_MIN}
            max={TIMEOUT_MAX}
            precision={0}
            suffix={t('mu.units.ms')}
            onChange={(timeoutMs) => typeof timeoutMs === 'number' && update({ timeoutMs })}
          />
        </Row>
        <Row title={t('mu.judges.keyVariable')} help={t('mu.judges.keyVariableHelp')} modified={changed('apiKeyEnv')}>
          <Input
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.judges.keyVariable')}
            value={judge.apiKeyEnv}
            onChange={(apiKeyEnv) => update({ apiKeyEnv })}
          />
        </Row>
        {judge.apiKeyEnv ? (
          <Row
            title={t('mu.apiKey')}
            help={t('mu.keyHelp')}
            modified={Boolean(draft.judgeKeys[judge.apiKeyEnv])}
            badges={
              <Tag size='small' color={settings.keys[judge.apiKeyEnv] ? 'green' : undefined}>
                {t(settings.keys[judge.apiKeyEnv] ? 'mu.keyState.set' : 'mu.keyState.none')}
              </Tag>
            }
          >
            <Input.Password
              size='small'
              className={fieldStyles.wide}
              aria-label={t('mu.apiKey')}
              autoComplete='new-password'
              value={draft.judgeKeys[judge.apiKeyEnv] ?? ''}
              placeholder={t('mu.keyKeep')}
              onChange={(value) => onKey(judge.apiKeyEnv, value)}
            />
          </Row>
        ) : null}
      </Card>
    </div>
  );
}
