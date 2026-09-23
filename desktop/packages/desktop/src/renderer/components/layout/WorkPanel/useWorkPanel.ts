/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { ipcBridge } from '@/common';
import type { Activity } from '@/common/kyrn/types';
import { onHiveFocus, type HiveFocusRequest } from '@/renderer/pages/conversation/KyrnPanel/focus';
import { onPreviewOpened } from '@/renderer/pages/conversation/Preview/context/previewOpeners';
import { WORKSPACE_TOGGLE_EVENT, dispatchWorkspaceStateEvent } from '@/renderer/utils/workspace/workspaceEvents';
import { boardSignature, createEditWatcher, hiveSignature, judgeSignature, lessonsSignature } from './news';
import {
  bumpWorkPanelNews,
  noteWorkPanelSignature,
  readWorkPanelMemory,
  rememberWorkPanel,
  setWorkPanelViewing,
  useWorkPanelMemory,
  useWorkPanelUnread,
  type WorkPanelTab,
} from './workPanelStore';

/**
 * The work panel's wiring for the current conversation. What opens it: the titlebar button and Cmd/Ctrl+J (both
 * the workspace toggle event), a sub-agent line clicked in the transcript (its hive tab), and a file or page the
 * person opens (its preview). What only marks a tab as new: a new board, a new verdict, a sub-agent starting or
 * ending, a lesson stored, recalled, followed, retired or merged, a file the agent changed, a page the agent opened.
 * Nothing else the agent does opens the panel; the one exception is mu's browser typing into its page or asking the
 * person to confirm a step on it, which is done where the person can see it (see `previewOpeners.ts`).
 */
export function useWorkPanel(conversationId: string | null, kernel: { events: Activity[]; settled: boolean }) {
  const memory = useWorkPanelMemory(conversationId);
  const unread = useWorkPanelUnread(conversationId);
  const [focus, setFocus] = useState<HiveFocusRequest>();

  useEffect(() => {
    setFocus(undefined);
    if (!conversationId) return undefined;
    const toggle = (event: Event) => {
      // Handled: a keyboard caller suppresses the native chord only when a panel answered.
      event.preventDefault();
      rememberWorkPanel(conversationId, { open: !readWorkPanelMemory(conversationId).open });
    };
    window.addEventListener(WORKSPACE_TOGGLE_EVENT, toggle);
    const stopFocus = onHiveFocus((request) => {
      if (request.conversationId !== conversationId) return;
      setFocus(request);
      rememberWorkPanel(conversationId, { open: true, tab: 'hive' });
    });
    const stopPreview = onPreviewOpened((by) => {
      if (by === 'agent') bumpWorkPanelNews(conversationId, 'preview');
      else rememberWorkPanel(conversationId, { open: true, tab: 'preview' });
    });
    return () => {
      window.removeEventListener(WORKSPACE_TOGGLE_EVENT, toggle);
      stopFocus();
      stopPreview();
    };
  }, [conversationId]);

  // The titlebar button shows whether the panel is open.
  useEffect(() => {
    if (conversationId) dispatchWorkspaceStateEvent(!memory.open);
  }, [conversationId, memory.open]);

  // What the person looks at is seen as it arrives.
  const viewing = memory.open ? memory.tab : null;
  useEffect(() => {
    if (!conversationId) return undefined;
    setWorkPanelViewing(conversationId, viewing);
    return () => setWorkPanelViewing(conversationId, null);
  }, [conversationId, viewing]);

  // The kernel tabs' news, once the conversation's record has all arrived.
  useEffect(() => {
    if (!conversationId || !kernel.settled) return;
    noteWorkPanelSignature(conversationId, 'board', boardSignature(kernel.events));
    noteWorkPanelSignature(conversationId, 'judge', judgeSignature(kernel.events));
    noteWorkPanelSignature(conversationId, 'hive', hiveSignature(kernel.events));
    noteWorkPanelSignature(conversationId, 'lessons', lessonsSignature(kernel.events));
  }, [conversationId, kernel.events, kernel.settled]);

  // Files the agent changed, in any conversation: the dot waits there for the person's return.
  useEffect(() => {
    const stream = ipcBridge.conversation?.responseStream;
    if (!stream?.on) return undefined;
    const edited = createEditWatcher();
    return stream.on((message) => {
      if (message.conversation_id && edited(message)) bumpWorkPanelNews(message.conversation_id, 'files');
    });
  }, []);

  const select = useCallback(
    (tab: WorkPanelTab) => {
      if (conversationId) rememberWorkPanel(conversationId, { open: true, tab });
    },
    [conversationId]
  );
  const close = useCallback(() => {
    if (conversationId) rememberWorkPanel(conversationId, { open: false });
  }, [conversationId]);
  const resize = useCallback(
    (width: number) => {
      if (conversationId) rememberWorkPanel(conversationId, { width });
    },
    [conversationId]
  );

  return { memory, unread, focus, select, close, resize };
}
