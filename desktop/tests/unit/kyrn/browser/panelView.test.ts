import { describe, expect, it } from 'vitest';
import type { BrowserRunState } from '@/common/kyrn/browserRun';
import {
  barTone,
  clock,
  confidencePercent,
  elapsedMs,
  permissionKey,
  reasonLine,
  secondsLeft,
  statusKey,
  verbKey,
} from '@/renderer/pages/conversation/Preview/browser/muBrowser/format';
import { decideOpen } from '@/renderer/pages/conversation/Preview/browser/muBrowser/panelPolicy';

const run = (patch: Partial<BrowserRunState> = {}): BrowserRunState => ({
  tabId: 't1',
  conversationId: 'c1',
  phase: 'running',
  goal: '',
  startUrl: 'about:blank',
  startedAt: 1_000,
  paused: false,
  stopRequested: false,
  steps: [],
  notices: [],
  ...patch,
});

const browser = (id: string, isMu = false) => ({ id, isBrowser: true, isMu });
const file = (id: string) => ({ id, isBrowser: false, isMu: false });

describe('what the step bar says', () => {
  it('names the operation, and calls anything it does not know an operation', () => {
    expect(verbKey('click')).toBe('preview.muBrowser.verb.click');
    expect(verbKey('fill')).toBe('preview.muBrowser.verb.fill');
    expect(verbKey('none')).toBe('preview.muBrowser.verb.none');
    expect(verbKey('<script>')).toBe('preview.muBrowser.verb.other');
    expect(statusKey('needs_confirmation')).toBe('preview.muBrowser.status.needs_confirmation');
  });

  it('shows the judge’s probability as a percentage, or nothing when there is none', () => {
    const step = { step: 3, kind: 'click', action: 'Search', url: '', at: 0 };
    expect(confidencePercent({ ...step, probability: 0.918 })).toBe(92);
    expect(confidencePercent({ ...step, probability: 1 })).toBe(100);
    expect(confidencePercent(step)).toBeUndefined();
  });

  it('counts the time of a run, and stops counting when it has finished', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(65_400)).toBe('1:05');
    expect(clock(3_725_000)).toBe('1:02:05');
    expect(clock(-5)).toBe('0:00');
    expect(elapsedMs(run(), 61_000)).toBe(60_000);
    expect(elapsedMs(run({ phase: 'finished', finishedAt: 5_000 }), 99_000)).toBe(4_000);
  });

  it('counts a confirmation down to zero and not below', () => {
    expect(secondsLeft(120_000, 0)).toBe(120);
    expect(secondsLeft(120_000, 119_100)).toBe(1);
    expect(secondsLeft(120_000, 125_000)).toBe(0);
  });

  it('only looks pleased when the harness itself said done', () => {
    expect(barTone(run())).toBe('running');
    expect(barTone(run({ paused: true, pausedBy: 'interaction' }))).toBe('paused');
    expect(barTone(run({ stopRequested: true }))).toBe('stopping');
    expect(barTone(run({ phase: 'finished', status: 'done' }))).toBe('good');
    expect(barTone(run({ phase: 'finished', status: 'ended' }))).toBe('quiet');
    expect(barTone(run({ phase: 'finished', status: 'stopped' }))).toBe('quiet');
    expect(barTone(run({ phase: 'finished', status: 'needs_confirmation' }))).toBe('warn');
    expect(barTone(run({ phase: 'finished', status: 'budget' }))).toBe('warn');
    expect(barTone(run({ phase: 'finished', status: 'detached' }))).toBe('bad');
  });
});

describe('where a new run gets its tab', () => {
  it('opens a new tab while there is room', () => {
    expect(decideOpen([file('f'), browser('b1')], {}, 'c1', 10)).toEqual({ kind: 'new' });
  });

  it('hands out the conversation’s own finished mu tab again, oldest first, never one that is running', () => {
    const runs = {
      m1: run({ tabId: 'm1', phase: 'finished', status: 'done', startedAt: 5 }),
      m2: run({ tabId: 'm2', phase: 'finished', status: 'ended', startedAt: 2 }),
      m3: run({ tabId: 'm3', startedAt: 1 }),
      other: run({ tabId: 'other', conversationId: 'c2', phase: 'finished', status: 'done', startedAt: 0 }),
    };
    const tabs = [browser('m1', true), browser('m2', true), browser('m3', true), browser('other', true)];
    expect(decideOpen(tabs, runs, 'c1', 10)).toEqual({ kind: 'reuse', tabId: 'm2' });
    expect(decideOpen(tabs, runs, 'c3', 10)).toEqual({ kind: 'new' });
    // A run the store knows but whose tab is gone from the panel is not a tab to hand out.
    expect(decideOpen([browser('m3', true)], runs, 'c1', 10)).toEqual({ kind: 'new' });
  });

  it('refuses when the panel is full rather than take over a tab someone is using', () => {
    const full = Array.from({ length: 10 }, (_unused, index) => browser(`b${index}`));
    const decision = decideOpen(full, {}, 'c1', 10);
    expect(decision.kind).toBe('refuse');
    expect(decision.kind === 'refuse' && decision.error).toContain('full');
    // Full, but one of them is this conversation's finished mu tab: that one is used.
    const runs = { b3: run({ tabId: 'b3', phase: 'finished', status: 'done' }) };
    const withMu = full.map((tab) => browser(tab.id, tab.id === 'b3'));
    expect(decideOpen(withMu, runs, 'c1', 10)).toEqual({ kind: 'reuse', tabId: 'b3' });
  });
});

describe('what the step bar says about the end of a run and what the app refused', () => {
  it('translates a detached run’s code, offers an unknown cause as a technical detail, and keeps the harness’s words', () => {
    const finished = { phase: 'finished' as const, status: 'detached' as const };
    expect(reasonLine(run({ ...finished, reason: 'tab_closed' }))).toEqual({
      labelKey: 'preview.muBrowser.detachCause',
      key: 'preview.muBrowser.detachReason.tab_closed',
    });
    expect(reasonLine(run({ ...finished, reason: 'target gone sideways' }))).toEqual({
      labelKey: 'common.technical_details',
      text: 'target gone sideways',
    });
    expect(reasonLine(run({ phase: 'finished', status: 'done', reason: 'Found it' }))).toEqual({
      labelKey: 'preview.muBrowser.reason',
      text: 'Found it',
    });
    expect(reasonLine(run({ reason: 'still going' }))).toBeUndefined();
    expect(reasonLine(run({ phase: 'finished', status: 'done' }))).toBeUndefined();
  });

  it('names Electron’s permission ids, and nothing else (no prototype names)', () => {
    expect(permissionKey('geolocation')).toBe('preview.muBrowser.permission.location');
    expect(permissionKey('clipboard-read')).toBe('preview.muBrowser.permission.clipboard');
    expect(permissionKey('media')).toBe('preview.muBrowser.permission.media');
    expect(permissionKey('constructor')).toBeUndefined();
    expect(permissionKey('brand-new')).toBeUndefined();
  });
});
