import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';

vi.mock('@/common', () => ({
  ipcBridge: {
    database: {
      getConversationMessage: {
        invoke: vi.fn(),
      },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, options?: Record<string, unknown>) => {
      const templates: Record<string, string> = {
        'tools.execution.callAria': '{{name}} · {{status}}',
        'tools.activity.running': '{{steps}} steps · running {{label}}',
        'tools.activity.summary': '{{steps}} steps',
        'tools.activity.summaryFailed': '{{steps}} steps · {{failed}} failed',
      };
      const template = templates[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
        options && name in options ? String(options[name]) : match
      );
    },
  }),
}));

let callSeq = 0;
const tool = (
  name: string,
  status: 'completed' | 'error' | 'running' | 'pending' | 'canceled',
  input?: Record<string, unknown>,
  output?: string
): ToolMessage => {
  const id = `${name}-${status}-${(callSeq += 1)}`;
  return {
    id,
    conversation_id: 'conversation-1',
    type: 'tool_call',
    content: {
      call_id: id,
      name,
      args: input ?? {},
      status,
      output,
    },
  } as ToolMessage;
};

afterEach(() => {
  vi.mocked(ipcBridge.database.getConversationMessage.invoke).mockReset();
});

describe('MessageToolGroupSummary', () => {
  it('shows a lone call as its own line, with no summary box above it', () => {
    render(<MessageToolGroupSummary messages={[tool('read', 'completed', { path: 'src/app.ts' })]} />);

    const calls = within(screen.getByRole('group', { name: 'tools.execution.title' }));
    expect(calls.getByRole('button', { name: 'read · tools.status.success' })).toHaveTextContent('src/app.ts');
    // No header naming the group, no counts, no second copy of the call.
    expect(screen.queryByTestId('tool-activity-group')).not.toBeInTheDocument();
    expect(screen.getAllByText('src/app.ts')).toHaveLength(1);
  });

  it('folds a run of calls into one line that names what is running', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          tool('read', 'completed', { path: 'src/app.ts' }),
          tool('bash', 'running', { command: 'npm test' }),
          tool('write', 'pending', { path: 'src/app.ts' }),
        ]}
      />
    );

    expect(screen.getByTestId('tool-activity-group')).toBeInTheDocument();
    const header = screen.getByRole('button', { name: /3 steps/ });
    expect(header).toHaveTextContent('3 steps · running bash npm test');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    // The steps themselves wait for a click.
    expect(screen.queryByRole('button', { name: 'read · tools.status.success' })).not.toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'read · tools.status.success' })).toHaveTextContent('src/app.ts');
    expect(screen.getByRole('button', { name: 'bash · tools.status.executing' })).toHaveTextContent('npm test');
  });

  it('keeps a finished run folded, and says how many steps failed', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          tool('read', 'completed', { path: 'src/app.ts' }),
          tool('bash', 'error', { command: 'npm test' }, 'FAIL src/app.test.ts\n  1 test failed'),
        ]}
      />
    );

    const header = screen.getByRole('button', { name: /2 steps/ });
    expect(header).toHaveTextContent('2 steps · 1 failed');
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows a failed step’s own words without asking for a click', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          tool('read', 'completed', { path: 'src/app.ts' }),
          tool('bash', 'error', { command: 'npm test' }, 'FAIL src/app.test.ts\n  1 test failed'),
          tool('read', 'completed', { path: 'src/b.ts' }),
        ]}
      />
    );

    const error = screen.getByTestId('tool-activity-error');
    expect(error).toHaveTextContent('bash');
    expect(error).toHaveTextContent('FAIL src/app.test.ts');
    // Only the failure is surfaced — the successes stay folded.
    expect(screen.getAllByTestId('tool-activity-error')).toHaveLength(1);
  });

  it('keeps each call’s own status once the run is opened', () => {
    const { container } = render(
      <MessageToolGroupSummary
        messages={[
          tool('read', 'completed', { path: 'src/app.ts' }),
          tool('bash', 'running', { command: 'npm run lint' }),
          tool('write', 'error', { path: 'src/app.ts' }),
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /3 steps/ }));
    expect(container.querySelector('.arco-badge-status-success')).toBeInTheDocument();
    expect(container.querySelector('.arco-badge-status-processing')).toBeInTheDocument();
    expect(container.querySelector('.arco-badge-status-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'write · tools.status.error' })).toBeInTheDocument();
  });

  it('keeps raw output out of the page until its own call is opened', () => {
    render(
      <MessageToolGroupSummary
        messages={[tool('Shell Command', 'completed', { command: 'npm run lint' }, 'lint output: 0 problems')]}
      />
    );

    // The line shows the grey command preview only; output needs its own click.
    expect(screen.getByText('npm run lint')).toBeInTheDocument();
    expect(screen.queryByText('lint output: 0 problems')).not.toBeInTheDocument();
    const call = screen.getByRole('button', { name: 'Shell Command · tools.status.success' });
    expect(call).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(call);
    expect(call).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('lint output: 0 problems')).toBeInTheDocument();
    expect(screen.getByText('tools.execution.output')).toBeInTheDocument();
  });

  it('shows a no-detail call without making it an expandable log entry', () => {
    render(<MessageToolGroupSummary messages={[tool('Ping', 'completed')]} />);

    const calls = within(screen.getByRole('group', { name: 'tools.execution.title' }));
    expect(calls.getByText('Ping')).toBeInTheDocument();
    expect(calls.queryByRole('button')).not.toBeInTheDocument();
  });

  it('loads full tool content only when an individual compact call is opened', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessage.invoke);
    invoke.mockResolvedValue({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          raw_input: { pattern: 'needle', path: '.' },
          content: [{ type: 'content', content: { type: 'text', text: 'full output' } }],
        },
      },
    } as unknown as TMessage);

    render(
      <MessageToolGroupSummary
        messages={[
          {
            id: 'message-1',
            conversation_id: 'conversation-1',
            type: 'acp_tool_call',
            content: {
              _compact: { truncated: true, original_size: 90000, preview_chars: 4096 },
              update: {
                session_update: 'tool_call',
                tool_call_id: 'tool-1',
                status: 'completed',
                title: 'rg',
                kind: 'search',
                raw_input: { pattern: 'needle', path: '.' },
                content: [{ type: 'content', content: { type: 'text', text: 'preview' } }],
              },
            },
          } as unknown as ToolMessage,
        ]}
      />
    );

    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'rg · tools.status.success' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({ conversation_id: 'conversation-1', message_id: 'message-1' });
    });
    expect(await screen.findByText('full output')).toBeInTheDocument();
  });

  it('retries a failed full-output fetch', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessage.invoke);
    invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          content: [{ type: 'content', content: { type: 'text', text: 'recovered output' } }],
        },
      },
    } as unknown as TMessage);

    render(
      <MessageToolGroupSummary
        messages={[
          {
            id: 'message-1',
            conversation_id: 'conversation-1',
            type: 'acp_tool_call',
            content: {
              _compact: { truncated: true },
              update: {
                session_update: 'tool_call',
                tool_call_id: 'tool-1',
                status: 'completed',
                title: 'rg',
                kind: 'search',
              },
            },
          } as unknown as ToolMessage,
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'rg · tools.status.success' }));
    expect(await screen.findByText('tools.execution.loadError')).toBeInTheDocument();
    fireEvent.click(screen.getByText('tools.execution.retry'));

    expect(await screen.findByText('recovered output')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
