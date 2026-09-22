import React from 'react';
import { Radio } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { DECISION_MODES, localized, type DecisionMode, type HarnessManifest } from '@/common/kyrn/manifest';

/** The harness names its modes itself; without a manifest the app's own words are used. */
export function useModeLabels(manifest?: HarnessManifest): Record<DecisionMode, { label: string; help: string }> {
  const { t, i18n } = useTranslation();
  const labels = {} as Record<DecisionMode, { label: string; help: string }>;
  for (const mode of DECISION_MODES) {
    const described = manifest?.modes.find((item) => item.value === mode);
    labels[mode] = {
      label: described ? localized(described.label, i18n.language) : t(`mu.modes.${mode}`),
      help: described ? localized(described.help, i18n.language) : t(`mu.modes.${mode}Help`),
    };
  }
  return labels;
}

type ModeControlProps = {
  /** undefined: follow the default mode. */
  value: DecisionMode | undefined;
  onChange: (mode: DecisionMode | undefined) => void;
  labels: Record<DecisionMode, { label: string; help: string }>;
  /** Offer "follow default", naming the mode that is the default right now. */
  followDefault?: DecisionMode;
  disabled?: boolean;
  label: string;
};

const FOLLOW = 'follow';

/** Active / shadow / off, and for a single decision also "follow the default". */
export default function ModeControl({ value, onChange, labels, followDefault, disabled, label }: ModeControlProps) {
  const { t } = useTranslation();
  const options = [
    ...(followDefault
      ? [{ value: FOLLOW, label: t('mu.decisions.follow', { mode: labels[followDefault].label }) }]
      : []),
    ...DECISION_MODES.map((mode) => ({ value: mode as string, label: labels[mode].label })),
  ];
  return (
    <Radio.Group
      type='button'
      size='small'
      aria-label={label}
      disabled={disabled}
      value={value ?? FOLLOW}
      options={options}
      onChange={(next: string) => onChange(next === FOLLOW ? undefined : (next as DecisionMode))}
    />
  );
}
