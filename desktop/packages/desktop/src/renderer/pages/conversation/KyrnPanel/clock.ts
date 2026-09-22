import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@/renderer/services/i18n/format';

const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: 'numeric', second: 'numeric' };

/** The time of day in the app language. `toLocaleTimeString()` follows the operating system instead. */
export function formatClock(at: number | string | Date, language?: string | null): string {
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime()) ? '' : formatDateTime(date, language, CLOCK);
}

export function useClock(): (at: number | string | Date) => string {
  const { i18n } = useTranslation();
  const language = i18n?.language;
  return useCallback((at: number | string | Date) => formatClock(at, language), [language]);
}
