import type { TFunction } from 'i18next';
import { formatDuration } from '@/renderer/services/i18n/format';
import type { JudgeStage, ReasonParams } from './activity';

const KEY = 'common.kyrn.judgeView';

/** The `<kind>` of a failed judge call (`error:<kind>`); `all` is a batch in which every item failed. */
export const JUDGE_ERROR_KINDS = [
  'timeout',
  'aborted',
  'unreachable',
  'auth',
  'payment_required',
  'rate_limited',
  'bad_request',
  'server',
  'invalid_response',
  'unexpected',
  'all',
] as const;

/**
 * Why a judgment did not drive execution, other than an error: the decision's own reasons (`shadow`, `abstain`,
 * `off`), the preflight's (`skipped`, `no_answer`) and why its wait ended (`timeout`, `verdict`).
 */
export const JUDGE_REASONS = ['shadow', 'abstain', 'off', 'skipped', 'no_answer', 'timeout', 'verdict'] as const;

/**
 * The preflight's hints to the main model, by the id the harness records beside each sentence (the harness's
 * kyrn/docs/features/presentation-codes.md, preflight.verdict). `clarify` is an older harness's; the others are
 * what it sends now.
 */
export const PREFLIGHT_HINT_IDS = [
  'answered',
  'resolve',
  'clarify',
  'side_question',
  'plan_first',
  'try_hive',
  'try_delegate',
] as const;

/** What the preflight asks the judge, by question id. Other decision points keep their ids as recorded. */
export const PREFLIGHT_QUESTION_IDS = [
  'turn_type',
  'is_side_question',
  'needs_clarification',
  'needs_files_changed',
  'needs_memory',
  'swarm_worthy',
  'plan_first',
  'task_complexity',
  'reasoning_depth',
  'tool_complexity',
] as const;

const known = <T extends string>(ids: readonly T[], id: string): id is T => (ids as readonly string[]).includes(id);

/**
 * A recorded reason in the app language. A code this build has no words for is shown in the recorded English
 * (`fallback`), or as the code itself where the record has nothing else, so a reason the harness adds later still
 * says something; an empty one says nothing.
 */
export function reasonText(
  t: TFunction,
  language: string,
  code: string,
  params?: ReasonParams,
  fallback?: string
): string {
  if (!code) return '';
  if (code.startsWith('error:')) {
    const kind = code.slice('error:'.length);
    return t(`${KEY}.errorValue`, { kind: known(JUDGE_ERROR_KINDS, kind) ? t(`${KEY}.values.${kind}`) : kind });
  }
  if (code === 'no_answer' && params?.seconds !== undefined)
    return t(`${KEY}.noAnswerAfter`, { duration: formatDuration(params.seconds * 1000, language) });
  return known(JUDGE_REASONS, code) ? t(`${KEY}.values.${code}`) : fallback || code;
}

/**
 * The hints as the reader's language says them: by id where the record has one, otherwise the sentence the main
 * model was given (older records, or an id this build does not know).
 */
export function hintLines(t: TFunction, hints: readonly string[], hintIds: readonly string[]): string[] {
  return Array.from({ length: Math.max(hints.length, hintIds.length) }, (_, index) => {
    const id = hintIds[index] ?? '';
    return known(PREFLIGHT_HINT_IDS, id) ? t(`${KEY}.hints.${id}`) : (hints[index] ?? '');
  }).filter(Boolean);
}

/**
 * The short name of a hint for a chip after the verdict line ("Plan first"); an id this build does not know stays as
 * recorded, so a hint the harness adds later still shows. Empty ids (older records) have no chip.
 */
export function hintChips(t: TFunction, hintIds: readonly string[]): { id: string; label: string }[] {
  return hintIds
    .filter(Boolean)
    .map((id) => ({ id, label: known(PREFLIGHT_HINT_IDS, id) ? t(`${KEY}.hintChips.${id}`) : id }));
}

/**
 * The name of the question an answer belongs to. Only the preflight's ids have words here, so another decision
 * point's question that happens to share an id is not misnamed; any other id stays as recorded.
 */
export function answerLabel(t: TFunction, stage: JudgeStage, id: string): string {
  return stage === 'preflight' && known(PREFLIGHT_QUESTION_IDS, id) ? t(`${KEY}.answerIds.${id}`) : id;
}
