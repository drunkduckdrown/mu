/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TFunction } from 'i18next';
import type { PreviewContentType } from '@/common/types/office/preview';
import { BROWSER_TAB_FALLBACK_TITLE } from '../browser/constants';

/**
 * The title a tab gets when it has no name of its own: no file name was given, or a browser tab's page has not
 * reported a title yet.
 *
 * These are stored with the tab and persisted, so they are sentinels, never display text: a word stored at open time
 * would stay in the language of that moment. `previewTabDisplayTitle` shows the reader's word in their place each time
 * the tab strip renders, so an open tab follows a language switch. They keep their English spelling because tabs
 * persisted by earlier builds carry exactly these strings.
 */
const FALLBACK_TITLES = {
  markdown: 'Markdown',
  diff: 'Diff',
  code: 'Code',
  image: 'Image',
  browser: BROWSER_TAB_FALLBACK_TITLE,
  other: 'Preview',
} as const;

/** The stored title of a tab opened without a name. A code tab is named after its language when it has one. */
export function fallbackTabTitle(type: PreviewContentType, language?: string): string {
  switch (type) {
    case 'markdown':
    case 'diff':
    case 'image':
    case 'browser':
      return FALLBACK_TITLES[type];
    case 'code':
      return language || FALLBACK_TITLES.code;
    default:
      return FALLBACK_TITLES.other;
  }
}

/** A tab's title as the tab strip shows it: its own name, or the reader's word for a tab that has none. */
export function previewTabDisplayTitle(tab: { title: string; content_type: PreviewContentType }, t: TFunction): string {
  const { title, content_type: type } = tab;
  if (type === 'browser') return title && title !== FALLBACK_TITLES.browser ? title : t('preview.browser.newTab');
  if (title && title !== fallbackTabTitle(type)) return title;
  switch (type) {
    case 'markdown':
      return FALLBACK_TITLES.markdown;
    case 'diff':
      return t('preview.tabTitle.diff');
    case 'code':
      return t('preview.code');
    case 'image':
      return t('preview.tabTitle.image');
    default:
      return t('preview.preview');
  }
}
