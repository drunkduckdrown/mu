/**
 * The upstream locale files name the product "AionUi" in about 85 strings per language. Rewriting them would make
 * every upstream merge conflict, so the name is swapped where a string is shown instead: both i18next instances
 * (renderer and main process) run every resolved string, default values included, through `showAsMu`.
 *
 * Left alone on purpose: AionCore (the upstream backend's own component name), anything that is part of a URL, a
 * path, a file name, an identifier or an e-mail address, and the upper-case error codes (`AIONUI_…`). A hyphen after
 * the name is a file name (`AionUi-update-1.zip`) unless a capitalised word follows it: a German compound noun such
 * as `AionUi-Installation` or `AionUi-Team`, which is the name in a sentence.
 */

/** No lookbehind: the WebUI is opened in browsers that fail to parse one, which would break the whole bundle. */
const UPSTREAM_NAME = /(^|[^\w/.@:-])AionU[iI](?![\w/@]|-(?!\p{Lu}\p{Ll})|\.\w)/gu;

export const MU_DISPLAY_NAME = 'mu';

export function showAsMu(text: string): string {
  return text.includes('AionU') ? text.replace(UPSTREAM_NAME, `$1${MU_DISPLAY_NAME}`) : text;
}

/** i18next post-processor. Register with `.use(muNamePostProcessor)` and `postProcess: [MU_NAME_POST_PROCESSOR]`. */
export const MU_NAME_POST_PROCESSOR = 'muName';

export const muNamePostProcessor = {
  type: 'postProcessor' as const,
  name: MU_NAME_POST_PROCESSOR,
  process: (value: string): string => (typeof value === 'string' ? showAsMu(value) : value),
};
