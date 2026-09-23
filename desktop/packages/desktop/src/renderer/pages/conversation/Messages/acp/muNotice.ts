import type { TMessage } from '@/common/chat/chatLib';

/**
 * A notice the mu bridge adds to a conversation (`MU_NOTICES` in `process/agent/kyrn/KyrnAgent.ts`): a tool call whose
 * id starts with `mu:notice:` and whose input carries the notice's code. It is shown as one line in the reader's
 * language, not as a tool call; a code this build has no words for shows the bridge's English title.
 */
export const MU_NOTICE_CODES = ['answer_lost', 'bash_missing'] as const;
export type MuNoticeCode = (typeof MU_NOTICE_CODES)[number];
export type MuNotice = { code?: MuNoticeCode; title: string };

/** The i18n key of each notice's line. */
export const MU_NOTICE_KEYS: Readonly<Record<MuNoticeCode, string>> = {
  answer_lost: 'mu.notices.answerLost',
  bash_missing: 'mu.notices.bashMissing',
};

/** A page the line ends with, where the person can act on it: the same address in every language. */
export const MU_NOTICE_LINKS: Readonly<Partial<Record<MuNoticeCode, string>>> = {
  bash_missing: 'https://git-scm.com/download/win',
};

const NOTICE_ID = /^mu:notice:/;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const isCode = (value: string): value is MuNoticeCode => (MU_NOTICE_CODES as readonly string[]).includes(value);

/** The notice a message stands for, or undefined for any other message. */
export function muNotice(message: TMessage): MuNotice | undefined {
  if (message.type !== 'acp_tool_call') return undefined;
  const update = record(message.content?.update);
  const id = str(update.tool_call_id) || str(update.toolCallId);
  if (!NOTICE_ID.test(id)) return undefined;
  // The relay snake-cases the keys it passes on.
  const code = str(record(update.raw_input ?? update.rawInput).notice);
  return { ...(isCode(code) ? { code } : {}), title: str(update.title) };
}
