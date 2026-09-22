/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@/renderer/pages/conversation/explorer/ExplorerContainer', () => ({
  ExplorerContainer: ({ projectId }: { projectId: string }) => <div data-testid='explorer'>{projectId}</div>,
}));

vi.mock('@/renderer/pages/conversation/KyrnPanel', () => ({
  default: ({ conversationId, focus }: { conversationId: string; focus?: { runId: string } }) => (
    <div data-testid='kyrn-panel' data-focus-run={focus?.runId}>
      {conversationId}
    </div>
  ),
}));

import { ProjectPanelMobileOverlay } from '@/renderer/components/layout/ProjectPanelMobileOverlay';
import {
  resetCurrentConversationForTest,
  setCurrentConversation,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';

const panel = () => document.querySelector('[data-explorer-mobile-overlay]') as HTMLElement;

afterEach(() => {
  cleanup();
  resetCurrentConversationForTest();
});

describe('ProjectPanelMobileOverlay (P3 mobile)', () => {
  it('collapsed: panel slides off-screen but stays mounted; no backdrop/handle', () => {
    render(<ProjectPanelMobileOverlay projectId='p1' collapsed={true} onCollapse={() => {}} widthPx={360} />);
    const p = panel();
    expect(p.getAttribute('data-collapsed')).toBe('true');
    expect(p.style.transform).toBe('translateX(100%)');
    expect(p.style.pointerEvents).toBe('none');
    // Explorer stays mounted (no remount on open/close).
    expect(screen.getByTestId('explorer')).toHaveTextContent('p1');
    // No floating collapse handle when collapsed.
    expect(screen.queryByLabelText('common.collapse')).not.toBeInTheDocument();
  });

  it('open: panel on-screen, backdrop + floating handle present, both fire onCollapse', () => {
    const onCollapse = vi.fn();
    render(<ProjectPanelMobileOverlay projectId='p1' collapsed={false} onCollapse={onCollapse} widthPx={360} />);
    const p = panel();
    expect(p.getAttribute('data-collapsed')).toBe('false');
    expect(p.style.transform).toBe('translateX(0)');
    expect(p.style.width).toBe('360px');

    fireEvent.click(screen.getByLabelText('common.collapse')); // floating handle
    expect(onCollapse).toHaveBeenCalledTimes(1);

    // Backdrop is the fixed full-screen dimmer.
    const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop);
    expect(onCollapse).toHaveBeenCalledTimes(2);
  });

  it('renders Activity without Files for an active conversation without a project', () => {
    setCurrentConversation('conv-4');
    render(
      <ProjectPanelMobileOverlay
        projectId={null}
        collapsed={false}
        onCollapse={() => {}}
        widthPx={360}
        focus={{ conversationId: 'conv-4', runId: 'run-2' }}
      />
    );
    expect(screen.getByTestId('kyrn-panel')).toHaveTextContent('conv-4');
    expect(screen.getByTestId('kyrn-panel')).toHaveAttribute('data-focus-run', 'run-2');
    expect(screen.queryByTestId('explorer')).not.toBeInTheDocument();
    expect(screen.queryByText('common.kyrn.files')).not.toBeInTheDocument();
  });

  it('keeps the same mount across an open→close prop change (no remount)', () => {
    const { rerender } = render(
      <ProjectPanelMobileOverlay projectId='p1' collapsed={false} onCollapse={() => {}} widthPx={360} />
    );
    const first = panel().getAttribute('data-mount-id');
    rerender(<ProjectPanelMobileOverlay projectId='p1' collapsed={true} onCollapse={() => {}} widthPx={360} />);
    expect(panel().getAttribute('data-mount-id')).toBe(first);
  });
});
