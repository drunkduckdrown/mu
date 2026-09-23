/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NormalizedToolCall, NormalizedToolStatus } from '@/common/chat/normalizeToolCall';

/**
 * How a stretch of tool calls reads when it is folded into one line.
 *
 * A turn can run a dozen tools; listing them all costs the reply its shape. One line says how many steps ran and what
 * is happening right now, and opens to the steps themselves. What went wrong is never folded away: a failed step keeps
 * its own line under the fold, so a failure is read without a click.
 */

/** A tool call in the box: the verb it ran as (`read`, `bash`) and what it ran on (`src/a.ts`, `npm test`). */
export type ToolLabel = { verb: string; target?: string };

export type ToolActivityStatus = 'running' | 'error' | 'done';

export type ToolActivitySummary = {
  /** How many calls the stretch holds. */
  steps: number;
  status: ToolActivityStatus;
  /** The call the box is waiting on, when one is still running. */
  running?: ToolLabel;
  failed: number;
};

export type ToolActivityError = { key: string; label: ToolLabel; line: string };

/** A call still on its way: `pending` is a call the agent announced but has not started. */
const isLive = (status: NormalizedToolStatus): boolean => status === 'running' || status === 'pending';

/**
 * The one string worth showing next to a tool's name. A JSON input is mined for the argument that names the work
 * (a command, a path, a query); anything else falls back to its first line, then to the call's own description.
 */
export const inputPreview = (input?: string): string | undefined => {
  if (!input) return undefined;
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of ['command', 'file_path', 'path', 'query', 'pattern', 'url', 'prompt']) {
        if (typeof record[key] === 'string' && record[key]) return record[key];
      }
      return undefined;
    }
  } catch {
    return input.split('\n', 1)[0] || undefined;
  }
  return undefined;
};

export const toolLabel = (item: NormalizedToolCall): ToolLabel => ({
  verb: item.name,
  target: inputPreview(item.input) || item.description || undefined,
});

/** An error said in one line: the first line of the output that carries words, cut to something a row can hold. */
const ERROR_LINE_MAX = 160;

export const toolErrorLine = (item: NormalizedToolCall): string | undefined => {
  const source = item.output || item.description || '';
  const line = source
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return undefined;
  return line.length > ERROR_LINE_MAX ? `${line.slice(0, ERROR_LINE_MAX - 1)}…` : line;
};

/** What the folded line says: the count, whether anything is still running, and how many calls failed. */
export function summarizeToolActivity(tools: NormalizedToolCall[]): ToolActivitySummary {
  const running = tools.find((item) => isLive(item.status));
  const failed = tools.filter((item) => item.status === 'error').length;
  return {
    steps: tools.length,
    status: running ? 'running' : failed > 0 ? 'error' : 'done',
    ...(running ? { running: toolLabel(running) } : {}),
    failed,
  };
}

/** The failures of a stretch, one line each. These stay visible while the group is closed. */
export function toolActivityErrors(tools: NormalizedToolCall[]): ToolActivityError[] {
  return tools.flatMap((item) => {
    if (item.status !== 'error') return [];
    const line = toolErrorLine(item);
    return line ? [{ key: item.key, label: toolLabel(item), line }] : [];
  });
}

/**
 * Below this a stretch is just its line. A header over a single call is a box more than it is a summary (user,
 * 2026-09-22), and from two calls up the fold is what keeps a long turn readable.
 */
export const ACTIVITY_FOLD_MIN = 2;

/** Whether a stretch of calls is worth folding into one line at all. */
export const shouldFoldActivity = (tools: NormalizedToolCall[]): boolean => tools.length >= ACTIVITY_FOLD_MIN;

// ── clipping long output ────────────────────────────────────────────────────

/** A tool's output opens to at most this much before "show more" takes over. */
export const OUTPUT_CLIP_LINES = 14;
export const OUTPUT_CLIP_CHARS = 1400;

export type ClippedText = { text: string; clipped: boolean };

/** The head of a long output, cut on a line boundary, with whether anything was left out. */
export function clipOutput(
  value: string,
  { lines = OUTPUT_CLIP_LINES, chars = OUTPUT_CLIP_CHARS }: { lines?: number; chars?: number } = {}
): ClippedText {
  const rows = value.split('\n');
  const head = rows.length > lines ? rows.slice(0, lines).join('\n') : value;
  if (head.length <= chars) return { text: head, clipped: head.length < value.length };
  return { text: head.slice(0, chars), clipped: true };
}
