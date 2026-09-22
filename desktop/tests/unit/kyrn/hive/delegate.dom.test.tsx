import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import type { ActivityPage, Result } from '@/common/kyrn/types';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import enTools from '@/renderer/services/i18n/locales/en-US/tools.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import zhTools from '@/renderer/services/i18n/locales/zh-CN/tools.json';
import KyrnPanel from '@/renderer/pages/conversation/KyrnPanel';
import Hive from '@/renderer/pages/conversation/KyrnPanel/Hive';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';
import { activity as hiveActivity, hiveMessage, hiveSnapshot } from './hiveFixtures';

const { activity } = vi.hoisted(() => ({ activity: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { activity: { invoke: activity } },
  unwrap: (result: Result<ActivityPage>) => {
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
}));
vi.mock('@/renderer/components/media/LocalImageView', () => ({ default: () => null }));
vi.mock('@/renderer/utils/file/download', () => ({ downloadFileFromPath: vi.fn() }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'zh-CN',
    fallbackLng: 'en-US',
    resources: {
      'en-US': { translation: { common: enCommon, mu: enMu, tools: enTools } },
      'zh-CN': { translation: { common: zhCommon, mu: zhMu, tools: zhTools } },
    },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <I18nextProvider i18n={i18n}>
    <MemoryRouter>{children}</MemoryRouter>
  </I18nextProvider>
);

describe('Sub-agent views in the app language', () => {
  it('words a delegate run: its title, what each bee did, and why it stopped', async () => {
    const snapshot = {
      kind: 'delegate',
      title: '2 tasks',
      titleCode: { code: 'delegate_tasks', params: { count: 2 } },
      bees: [
        {
          name: 'reviewer',
          status: 'timed-out',
          error: 'no sign of life from its bash call for 15m00s',
          errorCode: 'stalled',
          errorParams: { what: 'tool', tool: 'bash', seconds: 900 },
          recent: [
            { at: 1_000, text: 'bash npm test', code: 'tool_call', params: { tool: 'bash', summary: 'bash npm test' } },
            { at: 2_000, text: 'bash failed', code: 'tool_failed', params: { tool: 'bash' } },
            { at: 3_000, text: 'compacting its context', code: 'compacting' },
            { at: 4_000, text: 'an older line without a code' },
          ],
        },
      ],
    };
    activity.mockResolvedValue({
      ok: true,
      data: {
        sessionId: 'session',
        cursor: 1,
        more: false,
        events: [{ id: 'run-1', at: 1, kind: 'swarm.snapshot', run: 'run-1', payload: snapshot }],
      },
    });
    render(
      <KyrnPanel conversationId='conv' focus={{ conversationId: 'conv', runId: 'run-1', beeName: 'reviewer' }} />,
      { wrapper: Wrapper }
    );

    expect(await screen.findByText('2 个任务')).toBeVisible();
    expect(screen.queryByText('2 tasks')).not.toBeInTheDocument();
    const run = screen.getByText('2 个任务').closest('[data-hive-run]') as HTMLElement;
    expect(within(run).getByText('bash npm test')).toBeVisible();
    expect(within(run).getByText('bash 失败')).toBeVisible();
    expect(within(run).getByText('正在压缩上下文')).toBeVisible();
    expect(within(run).getByText('an older line without a code')).toBeVisible();
    expect(within(run).getByText(/^bash 调用已 .+ 没有任何动静$/)).toBeVisible();
    expect(within(run).queryByText(/no sign of life/)).not.toBeInTheDocument();
    // The log is read as lines now, not as the raw JSON of the snapshot.
    expect(within(run).queryByText(/"code":/)).not.toBeInTheDocument();
  });

  it('words a hive bee that did not report in time, and keeps a model message as data', () => {
    const failed = {
      ...hiveSnapshot,
      bees: [
        {
          ...hiveSnapshot.bees[0],
          status: 'failed',
          error: 'overloaded_error',
          errorCode: 'model_error',
          errorParams: { message: 'overloaded_error', stopReason: 'error' },
        },
      ],
    };
    render(
      <Hive
        events={[hiveActivity('snapshot', 'swarm.snapshot', failed)]}
        focus={{ conversationId: 'conversation-1', runId: 'run-1', beeName: 'prefix-mutations' }}
      />,
      { wrapper: Wrapper }
    );
    const inspector = screen.getByRole('region', { name: zhCommon.kyrn.hiveView.context });
    expect(within(inspector).getByText('模型请求失败：overloaded_error')).toBeInTheDocument();
  });

  it('words the routing step of a delegate call in its output, and leaves later output as it is', () => {
    const message = hiveMessage();
    message.content.update.title = 'delegate';
    message.content.update.rawInput = { tasks: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] };
    message.content.update.rawOutput = { details: { code: 'choosing_roles', params: { count: 3 } } };
    message.content.update.content = [
      {
        type: 'content',
        content: { type: 'text', text: 'choosing a role, a model and a thinking level for 3 sub-agents…' },
      },
    ];
    const { rerender } = render(<MessageToolGroupSummary messages={[message]} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: `delegate · ${zhTools.status.executing}` }));
    expect(screen.getByText('正在为 3 个子代理选择角色、模型和思考强度…')).toBeInTheDocument();
    expect(screen.queryByText(/choosing a role/)).not.toBeInTheDocument();

    const later = hiveMessage();
    later.content.update.title = 'delegate';
    later.content.update.rawOutput = { details: { snapshot: { ...hiveSnapshot, kind: 'delegate' } } };
    rerender(<MessageToolGroupSummary messages={[later]} />);
    expect(screen.getByText(/Original terminal evidence/)).toBeInTheDocument();
  });
});
