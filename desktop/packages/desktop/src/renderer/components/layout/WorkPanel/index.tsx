/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { ExplorerContainer, type ExplorerView } from '@/renderer/pages/conversation/explorer/ExplorerContainer';
import { KernelBody, useKyrnActivity, type KernelTab } from '@/renderer/pages/conversation/KyrnPanel';
import { PreviewPanel, usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { useWorkPanel } from './useWorkPanel';
import WorkPanelTabs, { workPanelBodyId, workPanelTabId } from './WorkPanelTabs';
import { WORK_PANEL_DEFAULT_WIDTH, WORK_PANEL_MIN_WIDTH, type WorkPanelTab } from './workPanelStore';
import styles from './WorkPanel.module.css';

/**
 * The transcript keeps at least this much of the row while the panel sits beside it: the app's minimum content width
 * (`--app-min-width`, which the route content keeps too), about a phone's. Its lines stay readable and the composer
 * stays whole: its toolbar wraps and its chips give up label width before anything is hidden.
 */
export const MIN_TRANSCRIPT_PX = 360;
/** The panel takes at most this share of the window. */
const MAX_WINDOW_SHARE = 0.6;
/** The panel's hairline edge, drawn outside its width. */
const EDGE_PX = 1;
/** The mobile sheet: most of the screen, capped. */
const SHEET_SHARE = 0.85;
const SHEET_MAX_PX = 420;
/** One arrow key press on the resize handle. */
const KEY_STEP_PX = 16;
/**
 * What a floating panel leaves uncovered at the bottom of the row: the plan bar, the composer and what sits on it
 * (the queue, the working line). The chat pages mark these with `data-composer-zone`; any send box counts too.
 */
const COMPOSER_ZONE = '[data-composer-zone], .sendbox-panel';
/** The gap between a floating panel's bottom edge and the composer. */
const COMPOSER_GAP_PX = 8;

/**
 * Where the panel sits and how wide it is. Beside the transcript (`dock`) while both fit: at least 270px for the
 * panel, at most 60% of the window, and 360px left for the transcript, which shrinks rather than being covered. A
 * window too narrow for that shows the panel over the transcript (`float`), above the composer, and a phone as a
 * sheet from the side (`sheet`).
 */
export function panelGeometry(
  rowWidth: number,
  viewportWidth: number,
  isMobile: boolean,
  wanted: number
): { mode: 'dock' | 'float' | 'sheet'; width: number; max: number } {
  if (isMobile) {
    const width = Math.min(viewportWidth, SHEET_MAX_PX, Math.max(WORK_PANEL_MIN_WIDTH, viewportWidth * SHEET_SHARE));
    return { mode: 'sheet', width: Math.round(width), max: Math.round(width) };
  }
  const byWindow = Math.floor(viewportWidth * MAX_WINDOW_SHARE);
  const inFlow = rowWidth > 0 ? Math.min(byWindow, rowWidth - MIN_TRANSCRIPT_PX - EDGE_PX) : byWindow;
  if (inFlow >= WORK_PANEL_MIN_WIDTH) {
    return { mode: 'dock', max: inFlow, width: Math.min(inFlow, Math.max(WORK_PANEL_MIN_WIDTH, wanted)) };
  }
  const max = Math.min(Math.max(WORK_PANEL_MIN_WIDTH, byWindow), rowWidth > 0 ? rowWidth - EDGE_PX : Infinity);
  return { mode: 'float', max, width: Math.min(max, Math.max(WORK_PANEL_MIN_WIDTH, wanted)) };
}

const useViewportWidth = (): number => {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return width;
};

/**
 * How far a floating panel stops above the row's bottom so that it never covers the composer: the distance from the
 * top of the composer zone to the bottom of the row, plus a small gap. It follows the composer growing (a second
 * line, an attachment, the working line) and coming and going (another page); 0 while inactive or with no composer.
 */
function useComposerClearance(host: React.RefObject<HTMLElement | null>, active: boolean): number {
  const [clearance, setClearance] = useState(0);
  useEffect(() => {
    const row = host.current?.parentElement;
    if (!active || !row) {
      setClearance(0);
      return undefined;
    }
    let frame = 0;
    let sizes: ResizeObserver | null = null;
    const watched = new Set<Element>();
    const measure = () => {
      frame = 0;
      const zones = Array.from(row.querySelectorAll(COMPOSER_ZONE));
      for (const zone of watched) {
        if (!zones.includes(zone)) {
          sizes?.unobserve(zone);
          watched.delete(zone);
        }
      }
      let top = Infinity;
      for (const zone of zones) {
        if (!watched.has(zone)) {
          sizes?.observe(zone);
          watched.add(zone);
        }
        const rect = zone.getBoundingClientRect();
        if (rect.height > 0) top = Math.min(top, rect.top);
      }
      const bottom = row.getBoundingClientRect().bottom;
      setClearance(top < bottom ? Math.ceil(bottom - top) + COMPOSER_GAP_PX : 0);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    measure();
    const mutations = new MutationObserver(schedule);
    mutations.observe(row, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      mutations.disconnect();
      sizes?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [host, active]);
  return clearance;
}

/**
 * The drag handle between the transcript and the panel. It follows the pointer frame by frame and remembers the
 * width once, when the drag ends; a double click goes back to the default width; arrow keys move it in steps.
 */
function ResizeHandle({
  width,
  max,
  onLive,
  onCommit,
}: {
  width: number;
  max: number;
  onLive: (width: number | null) => void;
  onCommit: (width: number) => void;
}) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(WORK_PANEL_MIN_WIDTH, value)));
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' && event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    // The panel grows toward the transcript: leftward in a left-to-right page, rightward in a right-to-left one.
    const sign = getComputedStyle(handle).direction === 'rtl' ? 1 : -1;
    const from = event.clientX;
    let latest = width;
    let frame = 0;
    handle.setPointerCapture?.(event.pointerId);
    const cursor = document.body.style.cursor;
    const select = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setDragging(true);
    const move = (moveEvent: PointerEvent) => {
      latest = clamp(width + sign * (moveEvent.clientX - from));
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          onLive(latest);
        });
    };
    const end = () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = select;
      setDragging(false);
      onLive(null);
      onCommit(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
  };
  const nudge = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const grow = (event.key === 'ArrowLeft') !== rtl;
    onCommit(clamp(width + (grow ? KEY_STEP_PX : -KEY_STEP_PX)));
  };
  return (
    <div
      role='separator'
      aria-orientation='vertical'
      aria-label={t('common.workPanel.resize')}
      aria-valuemin={WORK_PANEL_MIN_WIDTH}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      className={styles.handle}
      data-dragging={dragging ? 'true' : undefined}
      data-testid='work-panel-resize'
      onPointerDown={start}
      onKeyDown={nudge}
      onDoubleClick={() => onCommit(clamp(WORK_PANEL_DEFAULT_WIDTH))}
    />
  );
}

/** The preview tab: the preview itself, or a line saying why there is none. */
function PreviewBody() {
  const { t } = useTranslation();
  const { isOpen, activeTab, tabs, showPreview } = usePreviewContext();
  // `data-project-preview-region` is the anchor the end-to-end preview tests find the preview by.
  if (isOpen && activeTab)
    return (
      <div className='h-full w-full overflow-hidden' data-project-preview-region>
        <PreviewPanel />
      </div>
    );
  return (
    <div className={styles.quiet}>
      {tabs.length ? (
        <>
          <span>{t('common.workPanel.previewHidden')}</span>
          <Button type='text' size='mini' className={styles.inlineAction} onClick={showPreview}>
            {t('common.show')}
          </Button>
        </>
      ) : (
        <span>{t('common.workPanel.previewEmpty')}</span>
      )}
    </div>
  );
}

const KERNEL_TABS: readonly KernelTab[] = ['board', 'judge', 'hive', 'lessons'];

/**
 * The conversation page's right side: one docked panel whose tabs hold the kernel's view of the conversation (the
 * plain-language board, the judge's log, the sub-agents, the lessons learned for the project), the project's files,
 * the preview and source control. It sits beside the transcript and above the per-conversation subtree, so switching
 * conversations never remounts the explorer or the preview. Every tab stays mounted while another is shown, and a
 * closed panel keeps its width inside: nothing reloads, and a page in the preview keeps its size.
 */
export default function WorkPanelHost({ rowWidth, isMobile }: { rowWidth: number; isMobile: boolean }) {
  const { t } = useTranslation();
  const conversationId = useCurrentConversation();
  const projectId = useCurrentProject();
  const activity = useKyrnActivity(conversationId);
  const { memory, unread, focus, select, close, resize } = useWorkPanel(conversationId, activity);
  const { isMaximized } = usePreviewContext();
  const viewportWidth = useViewportWidth();
  const [live, setLive] = useState<number | null>(null);
  const geometry = panelGeometry(rowWidth, viewportWidth, isMobile, live ?? memory.width);
  const { open, tab: active } = memory;
  const hostRef = useRef<HTMLElement>(null);
  const maximized = open && active === 'preview' && isMaximized && geometry.mode !== 'sheet';
  const clearance = useComposerClearance(
    hostRef,
    Boolean(conversationId) && geometry.mode === 'float' && open && !maximized
  );
  // 文件 and 源码 are one explorer: it keeps the view last asked for while another tab is shown.
  const [explorerView, setExplorerView] = useState<ExplorerView>('files');
  const wantedView: ExplorerView = active === 'source' ? 'changes' : active === 'files' ? 'files' : explorerView;
  if (wantedView !== explorerView) setExplorerView(wantedView);

  if (!conversationId) return null;

  const explorerActive = active === 'files' || active === 'source';
  const body = (
    key: WorkPanelTab | 'explorer',
    shown: boolean,
    labelledBy: WorkPanelTab,
    children: React.ReactNode
  ) => (
    <div
      key={key}
      role='tabpanel'
      id={workPanelBodyId(labelledBy)}
      aria-labelledby={workPanelTabId(labelledBy)}
      className={styles.body}
      data-active={shown ? 'true' : 'false'}
      data-body={key}
      inert={!shown}
    >
      {children}
    </div>
  );

  return (
    <>
      {geometry.mode === 'sheet' && open ? (
        <div className={styles.backdrop} onClick={close} aria-hidden='true' />
      ) : null}
      <aside
        ref={hostRef}
        className={styles.host}
        data-testid='work-panel'
        data-mode={geometry.mode}
        data-open={open ? 'true' : 'false'}
        data-maximized={maximized ? 'true' : undefined}
        data-lifted={clearance > 0 ? 'true' : undefined}
        aria-label={t('common.workPanel.label')}
        inert={!open}
        style={{
          width: maximized ? undefined : open || geometry.mode === 'sheet' ? geometry.width : 0,
          bottom: clearance > 0 ? clearance : undefined,
        }}
      >
        {open && geometry.mode !== 'sheet' && !maximized ? (
          <ResizeHandle width={geometry.width} max={geometry.max} onLive={setLive} onCommit={resize} />
        ) : null}
        <div className={styles.frame} style={{ width: maximized ? '100%' : geometry.width }}>
          <WorkPanelTabs active={active} unread={unread} onSelect={select} onClose={close} />
          <div className={styles.bodies}>
            {KERNEL_TABS.map((tab) =>
              body(
                tab,
                active === tab,
                tab,
                <KernelBody
                  key={conversationId}
                  tab={tab}
                  conversationId={conversationId}
                  activity={activity}
                  focus={focus}
                  visible={open && active === tab}
                />
              )
            )}
            {body(
              'explorer',
              explorerActive,
              active === 'source' ? 'source' : 'files',
              projectId ? (
                <ExplorerContainer
                  key={projectId}
                  projectId={projectId}
                  view={wantedView}
                  onViewChange={(view) => select(view === 'changes' ? 'source' : 'files')}
                />
              ) : (
                <p className={styles.quiet}>{t('common.workPanel.noProject')}</p>
              )
            )}
            {body('preview', active === 'preview', 'preview', <PreviewBody />)}
          </div>
        </div>
      </aside>
    </>
  );
}
