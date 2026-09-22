import React from 'react';
import { Alert } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import { formatDuration } from '@/renderer/services/i18n/format';

/**
 * An error as the panel shows it: a translated headline the person can act on, and the raw message of the harness,
 * the bridge or the OS under it as a detail. The detail is never the only text.
 */
export function ErrorNotice({ title, detail, className }: { title: string; detail?: string; className?: string }) {
  return (
    <Alert
      className={className}
      type='error'
      {...(detail
        ? {
            title,
            content: (
              <span className='text-12px text-t-secondary whitespace-pre-wrap break-words' dir='auto'>
                {detail}
              </span>
            ),
          }
        : { content: title })}
    />
  );
}

const amount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** What a bee has done so far, one plural-aware part per count: "3 turns · 1 tool call · 0 shared · 2 received". */
export function beeCounters(
  t: TFunction,
  bee: { turns?: unknown; toolCalls?: unknown; published?: unknown; received?: unknown }
): string {
  return [
    t('common.kyrn.beeCounts.turns', { count: amount(bee.turns) }),
    t('common.kyrn.beeCounts.tools', { count: amount(bee.toolCalls) }),
    t('common.kyrn.beeCounts.shared', { count: amount(bee.published) }),
    t('common.kyrn.beeCounts.received', { count: amount(bee.received) }),
  ].join(' · ');
}

/** How long a bee has been silent, in minutes and seconds of the app language rather than a raw count of seconds. */
export function quietLabel(t: TFunction, quietMs: number, language: string | undefined): string {
  return t('common.kyrn.quiet', { duration: formatDuration(quietMs, language, 'short') });
}
