import type { JudgeSettings, JudgeType, KyrnSettings } from '@/common/kyrn/types';

/**
 * The two kinds of judge a person chooses between: Jev, or Laya on this machine. The profiles behind them (jev,
 * jev-direct, jev-gateway, laya) and everything else (a model as judge, a mock, a self-hosted HTTP judge, the order
 * of several) are the advanced view.
 */
export type JudgeChoice = 'jev' | 'local';

export const JUDGE_CHOICES: readonly JudgeChoice[] = ['jev', 'local'];

const KIND_OF: Record<JudgeType, JudgeChoice | undefined> = {
  jev: 'jev',
  typesafe: 'jev',
  gateway: 'jev',
  local: 'local',
  llm: undefined,
  http: undefined,
  mock: undefined,
};

/** The profile a choice prefers when several of its kind exist: the built-in names. */
const PREFERRED: Record<JudgeChoice, string> = { jev: 'jev', local: 'laya' };

/** Where the key of a Jev profile is kept when the profile names none. */
export const JEV_KEY_VARIABLE = 'TYPESAFE_API_KEY';

/** What the first judge asked is: the choice shown as selected. Undefined for a mock or a self-hosted judge. */
export function choiceOf(settings: KyrnSettings): JudgeChoice | undefined {
  const first = settings.judges[settings.tiers[0]];
  return first ? KIND_OF[first.type] : undefined;
}

/** The profile a choice stands for: the one with the built-in name if it is of that kind, else the first that is. */
export function profileFor(settings: KyrnSettings, choice: JudgeChoice): string | undefined {
  const preferred = settings.judges[PREFERRED[choice]];
  if (preferred && KIND_OF[preferred.type] === choice) return PREFERRED[choice];
  return Object.keys(settings.judges).find((name) => KIND_OF[settings.judges[name].type] === choice);
}

/**
 * The settings with `choice` as the one judge. A cascade someone built by hand is replaced: the simple view has one
 * judge, the advanced view has the order.
 */
export function choose(settings: KyrnSettings, choice: JudgeChoice): KyrnSettings {
  const existing = profileFor(settings, choice);
  return existing ? { ...settings, tiers: [existing] } : settings;
}

/** The variable a Jev profile's key lives in. */
export const jevKeyVariable = (judge: JudgeSettings | undefined): string => judge?.apiKeyEnv || JEV_KEY_VARIABLE;
