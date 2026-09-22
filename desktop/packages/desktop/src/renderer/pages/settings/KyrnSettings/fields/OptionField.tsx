import React from 'react';
import { Input, InputNumber, InputTag, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import AionSelect from '@/renderer/components/base/AionSelect';
import { checkOption, localized, optionEquals, type OptionInfo, type OptionValue } from '@/common/kyrn/manifest';
import { formatNumber } from '@/renderer/services/i18n/format';
import Row from './Row';
import styles from './fields.module.css';

type OptionFieldProps = {
  option: OptionInfo;
  value: OptionValue;
  onChange: (value: OptionValue) => void;
  disabled?: boolean;
  /** Prefix for test ids and labels, e.g. the feature name. */
  scope: string;
};

const isFraction = (option: Extract<OptionInfo, { kind: 'number' }>): boolean =>
  !Number.isInteger(option.default) || (option.max !== undefined && option.max <= 1);

/**
 * One option of a feature, drawn from its description alone: the screen knows kinds, never option names.
 * A value that differs from the default is marked; one that cannot be saved says why.
 */
export default function OptionField({ option, value, onChange, disabled, scope }: OptionFieldProps) {
  const { t, i18n } = useTranslation();
  const label = localized(option.label, i18n.language);
  const help = localized(option.help, i18n.language);
  const problem = checkOption(option, value);
  const bound = (limit: number | undefined, infinite: string) =>
    limit === undefined ? infinite : formatNumber(limit, i18n.language);
  const range =
    option.kind === 'number' && (option.min !== undefined || option.max !== undefined)
      ? t('mu.options.range', { min: bound(option.min, '−∞'), max: bound(option.max, '∞') })
      : '';
  const unit = option.kind === 'number' ? localized(option.unit, i18n.language) : '';

  let control: React.ReactNode;
  switch (option.kind) {
    case 'boolean':
      control = (
        <Switch size='small' aria-label={label} checked={value === true} disabled={disabled} onChange={onChange} />
      );
      break;
    case 'number':
      control = (
        <InputNumber
          className={styles.number}
          size='small'
          aria-label={label}
          disabled={disabled}
          value={typeof value === 'number' ? value : undefined}
          min={option.min}
          max={option.max}
          step={isFraction(option) ? 0.05 : 1}
          precision={isFraction(option) ? 2 : 0}
          suffix={unit || undefined}
          onChange={(next) => onChange(typeof next === 'number' ? next : option.default)}
        />
      );
      break;
    case 'text':
      control = (
        <Input
          className={styles.wide}
          size='small'
          aria-label={label}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          placeholder={option.default || t('mu.options.emptyText')}
          onChange={onChange}
        />
      );
      break;
    case 'choice':
      control = (
        <AionSelect
          className={styles.wide}
          size='small'
          aria-label={label}
          disabled={disabled}
          value={typeof value === 'string' ? value : option.default}
          onChange={onChange}
          options={option.choices.map((choice) => ({
            value: choice.value,
            label: localized(choice.label, i18n.language),
          }))}
        />
      );
      break;
    case 'list':
    case 'numbers':
      control = (
        <InputTag
          className={styles.wide}
          size='small'
          aria-label={label}
          disabled={disabled}
          allowClear
          saveOnBlur
          value={Array.isArray(value) ? value.map(String) : []}
          placeholder={t(option.kind === 'numbers' ? 'mu.options.addNumber' : 'mu.options.addItem')}
          validate={(entry) =>
            option.kind === 'numbers' ? entry.trim() !== '' && Number.isFinite(Number(entry)) : entry.trim() !== ''
          }
          onChange={(entries: string[]) =>
            onChange(option.kind === 'numbers' ? entries.map(Number) : entries.map((entry) => entry.trim()))
          }
        />
      );
      break;
  }

  return (
    <Row
      testId={`mu-option-${scope}-${option.key}`}
      title={label}
      help={
        // The harness's help and the app's range sentence: separate lines, not one glued sentence.
        help || range ? (
          <>
            {help ? <div>{help}</div> : null}
            {range ? <div>{range}</div> : null}
          </>
        ) : undefined
      }
      modified={!optionEquals(value, option.default)}
      problem={problem ? t(`mu.options.problem.${problem}`) : undefined}
    >
      {control}
    </Row>
  );
}
