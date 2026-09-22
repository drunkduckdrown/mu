/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The errors the mu bridge raises into a conversation. The bridge runs as its own process without i18n and what it
 * raises is stored with the conversation, so it words them in fixed English (`MU_TURN_ERRORS` in
 * `process/agent/kyrn/KyrnAgent.ts`, plus the process errors of `piRpc.ts`) and the desktop recognises that text
 * here, wherever AionCore put it, to show a headline in the reader's language. The original text stays available as
 * a detail line.
 */
const MU_TURN_ERROR_TEXTS = [
  // Longer texts first: "mu process exited during the turn" also contains "mu process exited".
  ['processExited', 'mu process exited during the turn'],
  ['modelFailed', 'Model request failed'],
  ['turnRunning', 'A mu turn is already running'],
  ['busyConfig', 'Wait for the current turn before changing configuration'],
  ['unsupportedValue', 'Unsupported configuration value'],
  ['permissionsNotSwitched', 'mu did not switch permissions'],
  ['imageUnsupported', 'Unsupported image format or size'],
  ['contentUnsupported', 'This mu adapter accepts text, images and text resources'],
  ['wrongProject', 'Session belongs to a different project'],
  ['notPersisted', 'mu did not persist the session'],
  ['startFailed', 'mu failed to start'],
  ['timeout', 'mu control command timed out'],
  ['processClosed', 'mu process exited'],
  ['processClosed', 'mu process is closed'],
] as const;

export type MuTurnErrorCode = (typeof MU_TURN_ERROR_TEXTS)[number][0];

/** The mu bridge error found in these texts (the error's message, detail or tip content), if any. */
export function findMuTurnError(texts: ReadonlyArray<string | undefined | null>): MuTurnErrorCode | undefined {
  for (const [code, english] of MU_TURN_ERROR_TEXTS) {
    if (texts.some((value) => typeof value === 'string' && value.includes(english))) return code;
  }
  return undefined;
}

/** The i18n key of a mu bridge error's headline. */
export const muTurnErrorKey = (code: MuTurnErrorCode): string => `mu.turnErrors.${code}`;
