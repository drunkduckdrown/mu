import React, { type PropsWithChildren } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { IMessageAcpToolCall, TMessage } from '@/common/chat/chatLib';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  MessagePaginationProvider,
} from '@/renderer/pages/conversation/Messages/hooks';
import MessageList from '@/renderer/pages/conversation/Messages/MessageList';
import MessageJevLine from '@/renderer/pages/conversation/Messages/acp/MessageJevLine';
import { jevLine } from '@/renderer/pages/conversation/Messages/acp/jevLine';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';

// Jev's class for a message, as the mu adapter sends it (a tool call with a `jev:` id), is one line of its own.
// The list runs for real; unrelated rows are stubbed, as in the thinking-flow test.

vi.mock('react-i18next', async (original) => {
  const actual = await original<typeof import('react-i18next')>();
  return { ...actual };
});
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ key: 'location-key', state: {} }),
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({ conversation_id: 'conversation-1', type: 'acp' }),
}));

vi.mock('@/renderer/pages/team/hooks/TeamPermissionContext', () => ({
  useTeamPermission: () => null,
}));

let mockIsProcessing = true;
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({ isProcessing: mockIsProcessing, hydrated: true }),
}));

vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({
  useConversationArtifacts: () => [],
}));

vi.mock('@/renderer/pages/conversation/Messages/useAutoScroll', () => ({
  useAutoScroll: () => ({
    handleScrollerRef: () => {},
    handleContentRef: () => {},
    handleScroll: () => {},
    handleWheel: () => {},
    handlePointerDown: () => {},
    showScrollButton: false,
    scrollToBottom: () => {},
    scrollElementIntoView: () => {},
    hideScrollButton: () => {},
  }),
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageText', () => ({
  default: ({ message }: { message: { content: { content: string } } }) => <div>{message.content.content}</div>,
}));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageTips', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolCall', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroup', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageAgentStatus', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessagePermission', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpPermission', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpToolCall', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpTerminalOutput', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/MessageQuestion', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageCronTrigger', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageSkillSuggest', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/SelectionReplyButton', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/anchorRail', () => ({ MessageAnchorRail: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/MessageFileChanges', () => ({
  __esModule: true,
  default: () => null,
  parseDiff: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary', () => ({
  default: ({ messages }: { messages: IMessageAcpToolCall[] }) => (
    <div data-testid='tool-summary'>{messages.map((message) => message.id).join(',')}</div>
  ),
}));

afterEach(cleanup);

let created = 0;
const call = (id: string, update: Record<string, unknown>): IMessageAcpToolCall =>
  ({
    id,
    msg_id: id,
    conversation_id: 'conversation-1',
    type: 'acp_tool_call',
    position: 'left',
    created_at: ++created,
    content: {
      session_id: 'session-1',
      update: { sessionUpdate: 'tool_call_update', tool_call_id: id, status: 'completed', kind: 'execute', ...update },
    },
  }) as IMessageAcpToolCall;
const jev = (update: Record<string, unknown>) => call('jev:runtime-1:3', update);

describe('reading Jev’s class from the tool call the adapter sends', () => {
  it('reads the stage the adapter marks in rawOutput, whatever the title says', () => {
    expect(
      jevLine(jev({ title: 'Jev · Classifying', status: 'completed', rawOutput: { preflight: 'pending' } }))
    ).toEqual({
      stage: 'classifying',
    });
    expect(
      jevLine(
        jev({
          title: 'Jev · chat',
          rawOutput: { turnType: 'chat', state: 'applied', by: 'jev-latest', preflight: 'verdict' },
        })
      )
    ).toEqual({ stage: 'classified', turnType: 'chat', state: 'applied', byRule: false });
    // The adapter's current fallback title is spelled "Jev", and its class is no turn type.
    expect(jevLine(jev({ title: 'Jev · Fallback', rawOutput: { preflight: 'fallback' } }))).toEqual({
      stage: 'fallback',
    });
    expect(jevLine(jev({ title: 'Jev · Default', rawOutput: { preflight: 'verdict', state: 'applied' } }))).toEqual({
      stage: 'fallback',
    });
  });

  it('is only a jev: call, classifying while it runs', () => {
    expect(jevLine(call('bash-1', { title: 'bash' }))).toBeUndefined();
    expect(jevLine({ ...call('x', {}), type: 'text' } as unknown as TMessage)).toBeUndefined();
    expect(jevLine(jev({ title: 'JeV · Classifying', status: 'in_progress' }))).toEqual({ stage: 'classifying' });
  });

  it('takes the class and its state from the verdict, and from the title when the verdict is not kept', () => {
    expect(
      jevLine(jev({ title: 'JeV · chat', rawOutput: { turnType: 'chat', state: 'applied', by: 'jev-latest' } }))
    ).toEqual({
      stage: 'classified',
      turnType: 'chat',
      state: 'applied',
      byRule: false,
    });
    expect(
      jevLine(jev({ title: 'JeV · research', raw_output: { turnType: 'research', state: 'shadow', by: 'rule' } }))
    ).toMatchObject({
      turnType: 'research',
      state: 'shadow',
      byRule: true,
    });
    expect(jevLine(jev({ title: 'JeV · single_edit' }))).toMatchObject({
      stage: 'classified',
      turnType: 'single_edit',
      state: 'applied',
    });
  });

  it('is a fallback when no class came: the wait ended, the class is unknown, or there was no verdict', () => {
    expect(jevLine(jev({ title: 'JeV · Fallback' }))).toEqual({ stage: 'fallback' });
    expect(jevLine(jev({ title: 'JeV · Default', rawOutput: { turnType: 'unknown', state: 'applied' } }))).toEqual({
      stage: 'fallback',
    });
    expect(jevLine(jev({ title: 'JeV · Default', rawOutput: { turnType: 'unknown', state: 'none' } }))).toEqual({
      stage: 'fallback',
    });
  });
});

const showLine = (lng: 'zh' | 'en', message: IMessageAcpToolCall) => {
  const i18n = createInstance();
  void i18n.init({
    lng,
    resources: { zh: { translation: { common: zhCommon } }, en: { translation: { common: enCommon } } },
    interpolation: { escapeValue: false },
  });
  const line = jevLine(message);
  if (!line) throw new Error('not a Jev line');
  return render(
    <I18nextProvider i18n={i18n}>
      <MessageJevLine line={line} />
    </I18nextProvider>
  );
};

describe('the line, in the language of the app', () => {
  it('says what Jev made of the message, in Chinese and in English', () => {
    const chat = jev({ title: 'JeV · chat', rawOutput: { turnType: 'chat', state: 'applied', by: 'jev-latest' } });
    const zh = showLine('zh', chat);
    expect(screen.getByTestId('mu-jev-line')).toHaveTextContent(/^Jev 归类为闲聊$/);
    zh.unmount();
    showLine('en', chat);
    expect(screen.getByTestId('mu-jev-line')).toHaveTextContent(/^Classified by Jev: Conversation$/);
  });

  it('keeps shadow, late, rule and fallback apart', () => {
    const { unmount } = showLine(
      'zh',
      jev({ title: 'JeV · research', rawOutput: { turnType: 'research', state: 'shadow' } })
    );
    expect(screen.getByTestId('mu-jev-line')).toHaveTextContent('Jev 归类为调研（仅观察，没有生效）');
    unmount();
    const late = showLine('zh', jev({ title: 'JeV · chat', rawOutput: { turnType: 'chat', state: 'late' } }));
    expect(screen.getByTestId('mu-jev-line')).toHaveTextContent('（来晚了，这一轮没用上）');
    late.unmount();
    const rule = showLine(
      'zh',
      jev({ title: 'JeV · chat', rawOutput: { turnType: 'chat', state: 'applied', by: 'rule' } })
    );
    expect(screen.getByTestId('mu-jev-line')).toHaveTextContent('按规则归类为闲聊');
    rule.unmount();
    const none = showLine('en', jev({ title: 'JeV · Fallback' }));
    expect(screen.getByTestId('mu-jev-line')).toHaveTextContent('No class from Jev this time');
    none.unmount();
    showLine('zh', jev({ title: 'JeV · Classifying', status: 'in_progress' }));
    expect(screen.getByTestId('mu-jev-line')).toHaveTextContent('Jev 正在归类…');
  });

  it('names a class it has no word for as "other", never by its raw id', () => {
    // A class a newer harness added, and a word that is a judge value but no class.
    for (const turnType of ['pair_programming', 'shadow']) {
      const message = jev({
        title: `JeV · ${turnType}`,
        rawOutput: { turnType, state: 'applied', preflight: 'verdict' },
      });
      const zh = showLine('zh', message);
      expect(screen.getByTestId('mu-jev-line')).toHaveTextContent(/^Jev 归类为其他$/);
      zh.unmount();
      const en = showLine('en', message);
      expect(screen.getByTestId('mu-jev-line')).toHaveTextContent(/^Classified by Jev: Other$/);
      en.unmount();
    }
  });
});

function Wrapper({ children, messages }: PropsWithChildren<{ messages: TMessage[] }>): JSX.Element {
  return (
    <MessageListLoadingProvider value={false}>
      <MessagePaginationProvider
        value={{ hasMoreBefore: false, hasMoreAfter: false, isLoadingBefore: false, isLoadingAnchor: false }}
      >
        <MessageListProvider value={messages}>{children}</MessageListProvider>
      </MessagePaginationProvider>
    </MessageListLoadingProvider>
  );
}

describe('in the conversation', () => {
  it('is one line of its own, and the tool box keeps only the real tools', () => {
    const messages: TMessage[] = [
      jev({ title: 'JeV · chat', rawOutput: { turnType: 'chat', state: 'applied' } }),
      call('bash-1', { title: 'bash' }),
      call('read-1', { title: 'read', kind: 'read' }),
    ];
    render(<MessageList />, { wrapper: ({ children }) => <Wrapper messages={messages}>{children}</Wrapper> });
    expect(screen.getAllByTestId('mu-jev-line')).toHaveLength(1);
    expect(screen.getByTestId('tool-summary')).toHaveTextContent(/^bash-1,read-1$/);
  });
});
