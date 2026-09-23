import React, { useEffect, useRef } from 'react';
import { kyrnBrowserBridge, type BrowserPanelRequest } from '@/common/kyrn/browserBridge';
import { useOptionalPreviewContext } from '../../context/PreviewContext';
import { announcePreviewOpened } from '../../context/previewOpeners';
import { BROWSER_BLANK_URL, MAX_BROWSER_TABS } from '../constants';
import ConfirmDialog from './ConfirmDialog';
import { decideOpen } from './panelPolicy';
import { browserRunsNow, useBrowserRuns } from './runsStore';
import { giveKeyboard } from './webviews';

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * The browser panel's side of the bridge: opens (or hands out again) a tab when mu starts a run, puts the keyboard
 * on a tab before mu types, brings a tab forward when mu asks a question, and shows that question. Mounted with
 * the conversation page, so the main process knows a panel can be shown exactly while one can.
 *
 * Everything here is the agent's doing, and announced as such: a run's tab opening only marks the work panel's
 * preview as new. Typing into the page and asking the person to confirm a step are done where the person can see
 * them, so those two bring the preview into view (`agent-watched`); a page out of view cannot take the keyboard.
 */
const MuBrowserHost: React.FC<{ conversationId?: string }> = ({ conversationId }) => {
  // Without a preview provider (some embedded layouts) there is no panel to offer, and nothing happens here.
  const preview = useOptionalPreviewContext();
  const runs = useBrowserRuns();
  // Requests arrive outside React's rendering: they read the latest panel through a ref.
  const latest = useRef({ preview, conversationId });
  latest.current = { preview, conversationId };
  const opening = useRef(new Map<string, string>());

  const hasPanel = preview !== null;
  useEffect(() => {
    if (!conversationId || !hasPanel) return undefined;
    void kyrnBrowserBridge.panel.invoke({ available: true });
    return () => void kyrnBrowserBridge.panel.invoke({ available: false });
  }, [conversationId, hasPanel]);

  useEffect(() => {
    const handle = async (request: BrowserPanelRequest) => {
      const { preview: panel, conversationId: visible } = latest.current;
      if (!panel) return;
      // The page comes into view: its tab in front, the preview shown, the work panel up on it.
      const bringIntoView = (tabId: string) => {
        if (panel.activeTabId !== tabId) panel.switchTab(tabId);
        if (!panel.isOpen) panel.showPreview();
        announcePreviewOpened('agent-watched');
      };
      if (request.kind === 'attention') {
        if (request.waiting) bringIntoView(request.tabId);
        return;
      }
      if (request.kind === 'keyboard') {
        // mu types where the person can see it: a page out of view is brought into view first.
        let held = panel.activeTabId === request.tabId && giveKeyboard(request.tabId);
        if (!held) {
          bringIntoView(request.tabId);
          await nextFrame();
          await nextFrame();
          held = giveKeyboard(request.tabId);
        }
        void kyrnBrowserBridge.answer.invoke({ kind: 'keyboard', requestId: request.requestId, held });
        return;
      }
      const owner = request.conversation ?? visible ?? '';
      const decision = decideOpen(
        panel.tabs.map((tab) => ({
          id: tab.id,
          isBrowser: tab.content_type === 'browser',
          isMu: Boolean(tab.metadata?.muRun),
        })),
        browserRunsNow(),
        owner,
        MAX_BROWSER_TABS
      );
      if (decision.kind === 'refuse') {
        void kyrnBrowserBridge.answer.invoke({ kind: 'open', requestId: request.requestId, error: decision.error });
      } else if (decision.kind === 'reuse') {
        // The main process blanks the page before the run starts. Doing it from here as well would be a second
        // navigation that can land after mu's own and wipe the page it had just opened.
        panel.switchTab(decision.tabId);
        announcePreviewOpened('agent');
        void kyrnBrowserBridge.answer.invoke({
          kind: 'open',
          requestId: request.requestId,
          tabId: decision.tabId,
          conversationId: owner,
        });
      } else {
        // The panel gives no id back: the new tab is recognised by the request id it carries (see below).
        opening.current.set(request.requestId, owner);
        panel.openPreview(BROWSER_BLANK_URL, 'browser', { muRun: request.requestId }, { by: 'agent' });
      }
    };
    return kyrnBrowserBridge.request.on((request) => void handle(request));
  }, []);

  const tabs = preview?.tabs;
  useEffect(() => {
    for (const [requestId, owner] of opening.current) {
      const tab = tabs?.find((candidate) => candidate.metadata?.muRun === requestId);
      if (!tab) continue;
      opening.current.delete(requestId);
      void kyrnBrowserBridge.answer.invoke({ kind: 'open', requestId, tabId: tab.id, conversationId: owner });
    }
  }, [tabs]);

  // One question at a time, the one that has waited longest.
  const asking = Object.values(runs)
    .filter((run) => run.confirm)
    .toSorted((a, b) => (a.confirm?.askedAt ?? 0) - (b.confirm?.askedAt ?? 0))[0];
  return asking ? <ConfirmDialog key={asking.confirm?.id} run={asking} /> : null;
};

export default MuBrowserHost;
