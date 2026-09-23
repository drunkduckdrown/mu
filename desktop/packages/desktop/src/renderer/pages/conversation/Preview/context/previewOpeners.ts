/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Who put something in the preview, which decides what the work panel does with it.
 *
 * - `user`: the person opened it (a file link, the explorer, a diff). The panel comes up on its preview.
 * - `agent`: the agent opened it (mu's browser starting a run, a tool's page). The preview tab only gets its dot:
 *   the agent does not open the panel.
 * - `agent-watched`: mu's browser is about to type into its page, or asks the person to confirm a step on it. That
 *   work is done where the person can see it (a page out of view cannot even take the keyboard), so this one agent
 *   action brings the panel up on its preview.
 */
export type PreviewOpener = 'user' | 'agent' | 'agent-watched';

const listeners = new Set<(by: PreviewOpener) => void>();

/** Hear every preview open, with who made it. */
export function onPreviewOpened(listener: (by: PreviewOpener) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Say that something was put in the preview. `openPreview` says it for every open; mu's browser also says it when
 * it brings an existing tab forward, which changes what the preview shows without opening anything.
 */
export function announcePreviewOpened(by: PreviewOpener): void {
  for (const listener of listeners) listener(by);
}
