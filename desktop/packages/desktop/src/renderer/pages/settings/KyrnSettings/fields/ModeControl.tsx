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
  value: DecisionMode;
  onChange: (mode: DecisionMode) => void;
  labels: Record<DecisionMode, { label: string; help: string }>;
  disabled?: boolean;
  label: string;
};

/** Active / shadow / off. */
export default function ModeControl({ value, onChange, labels, disabled, label }: ModeControlProps) {
  return (
    <Radio.Group
      type='button'
      aria-label={label}
      disabled={disabled}
      value={value}
      options={DECISION_MODES.map((mode) => ({ value: mode as string, label: labels[mode].label }))}
      onChange={(next: string) => onChange(next as DecisionMode)}
    />
  );
}
