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
    t: (key: string, options?: { count?: number; name?: string; status?: string }) => {
      if (key === 'tools.execution.callAria') return `${options?.name} · ${options?.status}`;
      if (key === 'tools.execution.calls') return `${options?.count} calls`;
      if (key === 'tools.execution.commands') return `${options?.count} commands`;
      return key;
    },
  }),
}));

const tool = (
  name: string,
  status: 'completed' | 'error' | 'running' | 'canceled',
  input?: Record<string, unknown>,
  output?: string
): ToolMessage =>
  ({
    id: `${name}-${status}`,
    conversation_id: 'conversation-1',
    type: 'tool_call',
    content: {
      call_id: `${name}-${status}`,
      name,
      args: input ?? {},
      status,
      output,
    },
  }) as ToolMessage;

afterEach(() => {
  vi.mocked(ipcBridge.database.getConversationMessage.invoke).mockReset();
});

describe('MessageToolGroupSummary', () => {
  it('shows calls, commands, and the latest command preview in its compact header', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          tool('Read', 'completed', { path: 'src/app.ts' }),
          tool('Shell Command', 'completed', { command: 'npm run lint' }),
        ]}
      />
    );

    const header = screen.getByRole('button', { name: /tools.execution.title/ });
    expect(header).toHaveTextContent('2 calls · 1 commands');
    expect(header).toHaveTextContent('tools.status.success');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('npm run lint')).toBeInTheDocument();
  });

  it('leaves the command count out when no call ran a command', () => {
    render(<MessageToolGroupSummary messages={[tool('Read', 'completed', { path: 'src/app.ts' })]} />);

    const header = screen.getByRole('button', { name: /tools.execution.title/ });
    expect(header).toHaveTextContent('1 calls');
    expect(header).not.toHaveTextContent('commands');
    expect(header).not.toHaveTextContent('·');
  });

  it('keeps a failed call visible in the collapsed header instead of reading as clean', () => {
    const { container } = render(
      <MessageToolGroupSummary
        messages={[
          tool('Shell Command', 'error', { command: 'npm test' }, 'exit 1'),
          tool('Read', 'completed', { path: 'src/app.ts' }),
        ]}
      />
    );

    const header = screen.getByRole('button', { name: /tools.execution.title/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveTextContent('tools.status.error');
    expect(header).not.toHaveTextContent('tools.status.success');
    expect(container.querySelector('.arco-badge-status-error')).toBeInTheDocument();
  });

  it('reports work in progress before earlier failures, and cancellation before success', () => {
    const { rerender } = render(
      <MessageToolGroupSummary
        messages={[
          tool('Write', 'error', { path: 'src/app.ts' }),
          tool('Shell Command', 'running', { command: 'npm run lint' }),
        ]}
      />
    );
    expect(screen.getByRole('button', { name: /tools.execution.title/ })).toHaveTextContent('tools.status.executing');

    rerender(
      <MessageToolGroupSummary
        messages={[
          tool('Read', 'completed', { path: 'src/app.ts' }),
          tool('Shell Command', 'canceled', { command: 'npm run lint' }),
        ]}
      />
    );
    expect(screen.getByRole('button', { name: /tools.execution.title/ })).toHaveTextContent('tools.status.canceled');
  });

  it('keeps raw output out of the page until its own call is opened', () => {
    render(
      <MessageToolGroupSummary
        messages={[tool('Shell Command', 'completed', { command: 'npm run lint' }, 'lint output: 0 problems')]}
      />
    );

    expect(screen.queryByText('lint output: 0 problems')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /tools.execution.title/ }));
    // The call list shows the grey command preview only; output still needs its own click.
    const calls = within(screen.getByRole('group', { name: 'tools.execution.title' }));
    expect(calls.getByText('npm run lint')).toBeInTheDocument();
    expect(screen.queryByText('lint output: 0 problems')).not.toBeInTheDocument();

    fireEvent.click(calls.getByRole('button', { name: 'Shell Command · tools.status.success' }));
    expect(screen.getByText('lint output: 0 problems')).toBeInTheDocument();
    expect(screen.getByText('tools.execution.output')).toBeInTheDocument();
  });

  it('opens running calls while retaining completed and failed statuses', () => {
    const { container } = render(
      <MessageToolGroupSummary
        messages={[
          tool('Read', 'completed', { path: 'src/app.ts' }),
          tool('Shell Command', 'running', { command: 'npm run lint' }),
          tool('Write', 'error', { path: 'src/app.ts' }),
        ]}
      />
    );

    expect(screen.getByRole('button', { name: /tools.execution.title/ })).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.arco-badge-status-success')).toBeInTheDocument();
    expect(container.querySelector('.arco-badge-status-processing')).toBeInTheDocument();
    expect(container.querySelector('.arco-badge-status-error')).toBeInTheDocument();
  });

  it('shows a no-detail call without making it an expandable log entry', () => {
    render(<MessageToolGroupSummary messages={[tool('Ping', 'completed')]} />);

    fireEvent.click(screen.getByRole('button', { name: /tools.execution.title/ }));
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
    fireEvent.click(screen.getByText('tools.execution.title'));
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

    fireEvent.click(screen.getByText('tools.execution.title'));
    fireEvent.click(screen.getByRole('button', { name: 'rg · tools.status.success' }));
    expect(await screen.findByText('tools.execution.loadError')).toBeInTheDocument();
    fireEvent.click(screen.getByText('tools.execution.retry'));

    expect(await screen.findByText('recovered output')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
