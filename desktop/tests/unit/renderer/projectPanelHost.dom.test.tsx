/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Stub the heavy tree; the column test only covers host chrome (gating, collapse).
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

import { ProjectPanelHost } from '@/renderer/components/layout/ProjectPanelHost';
import {
  setCurrentProject,
  resetCurrentProjectForTest,
} from '@/renderer/pages/conversation/explorer/currentProjectStore';
import {
  resetCurrentConversationForTest,
  setCurrentConversation,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';

beforeEach(() => {
  resetCurrentProjectForTest();
  resetCurrentConversationForTest();
});
afterEach(() => cleanup());

describe('ProjectPanelHost (Layout-level host chrome)', () => {
  it('renders nothing when there is no active project', () => {
    render(<ProjectPanelHost widthPx={260} collapsed={false} />);
    expect(document.querySelector('[data-explorer-column]')).toBeNull();
    expect(screen.queryByTestId('explorer')).not.toBeInTheDocument();
  });

  it('renders the explorer column (expanded) for the active project', () => {
    setCurrentProject('proj-9');
    render(<ProjectPanelHost widthPx={280} collapsed={false} />);
    const col = document.querySelector('[data-explorer-column]') as HTMLElement;
    expect(col).not.toBeNull();
    expect(col.getAttribute('data-mount-id')).toBeTruthy();
    expect(col.getAttribute('data-collapsed')).toBe('false');
    expect(col.style.width).toBe('280px');
    expect(screen.getByTestId('explorer')).toHaveTextContent('proj-9');
  });

  it('collapses to width 0 but keeps the explorer mounted (no remount)', () => {
    setCurrentProject('proj-9');
    render(<ProjectPanelHost widthPx={280} collapsed />);
    const col = document.querySelector('[data-explorer-column]') as HTMLElement;
    expect(col.getAttribute('data-collapsed')).toBe('true');
    expect(col.style.width).toBe('0px');
    // Component stays mounted — collapse is width-only, not an unmount.
    expect(screen.getByTestId('explorer')).toHaveTextContent('proj-9');
  });

  it('renders Activity without Files for an active conversation without a project', () => {
    setCurrentConversation('conv-4');
    render(<ProjectPanelHost widthPx={280} collapsed={false} />);
    expect(screen.getByTestId('kyrn-panel')).toHaveTextContent('conv-4');
    expect(screen.queryByTestId('explorer')).not.toBeInTheDocument();
    expect(screen.queryByText('common.kyrn.files')).not.toBeInTheDocument();
  });

  it('activates Activity and forwards a scoped Hive focus request', async () => {
    setCurrentProject('proj-9');
    setCurrentConversation('conv-4');
    const { rerender } = render(<ProjectPanelHost widthPx={280} collapsed={false} />);
    fireEvent.click(screen.getByText('common.kyrn.files'));
    expect(screen.queryByTestId('kyrn-panel')).not.toBeInTheDocument();

    rerender(
      <ProjectPanelHost
        widthPx={280}
        collapsed={false}
        focus={{ conversationId: 'conv-4', runId: 'run-2', beeName: 'reviewer' }}
      />
    );

    await waitFor(() => expect(screen.getByTestId('kyrn-panel')).toHaveAttribute('data-focus-run', 'run-2'));
  });

  it('does not render a duplicate collapse control inside the explorer column', () => {
    setCurrentProject('proj-9');
    render(<ProjectPanelHost widthPx={280} collapsed={false} />);
    expect(screen.queryByLabelText('common.collapse')).not.toBeInTheDocument();
  });
});
