import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IMessageAcpToolCall, TMessage } from '@/common/chat/chatLib';
import { MU_NOTICES } from '@/process/agent/kyrn/KyrnAgent';
import MessageMuNotice from '@/renderer/pages/conversation/Messages/acp/MessageMuNotice';
import {
  MU_NOTICE_CODES,
  MU_NOTICE_KEYS,
  MU_NOTICE_LINKS,
  muNotice,
} from '@/renderer/pages/conversation/Messages/acp/muNotice';
import { openExternalUrl } from '@/renderer/utils/platform';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';

// The mu bridge's notices (a `mu:notice:` tool call with the code in its input) are one line in the reader's language.

vi.mock('@/renderer/utils/platform', () => ({ openExternalUrl: vi.fn(async () => {}) }));

afterEach(() => {
  cleanup();
  vi.mocked(openExternalUrl).mockClear();
});

const LOCALES = join(__dirname, '../../../packages/desktop/src/renderer/services/i18n/locales');

const notice = (update: Record<string, unknown>, id = 'mu:notice:1'): IMessageAcpToolCall =>
  ({
    id,
    msg_id: id,
    conversation_id: 'conversation-1',
    type: 'acp_tool_call',
    position: 'left',
    created_at: 1,
    content: {
      session_id: 'session-1',
      update: { sessionUpdate: 'tool_call', tool_call_id: id, status: 'completed', kind: 'execute', ...update },
    },
  }) as IMessageAcpToolCall;

describe('the bridge’s notices', () => {
  it('reads the code from the call’s input, as the relay passes it on or as the bridge sent it', () => {
    const title = MU_NOTICES.answer_lost;
    expect(muNotice(notice({ title, raw_input: { notice: 'answer_lost' } }))).toEqual({ code: 'answer_lost', title });
    expect(muNotice(notice({ title, rawInput: { notice: 'answer_lost' } }))).toEqual({ code: 'answer_lost', title });
    // A code this build has no words for keeps the bridge's own line.
    expect(muNotice(notice({ title: 'Something new', raw_input: { notice: 'newer' } }))).toEqual({
      title: 'Something new',
    });
    expect(muNotice(notice({ title: 'bash' }, 'bash-1'))).toBeUndefined();
    expect(muNotice({ ...notice({}), type: 'text' } as unknown as TMessage)).toBeUndefined();
  });

  it('has a line in every language for every notice the bridge sends', () => {
    expect([...MU_NOTICE_CODES].toSorted()).toEqual(Object.keys(MU_NOTICES).toSorted());
    const languages = readdirSync(LOCALES).filter((name) => /^[a-z]{2}-[A-Z]{2}$/.test(name));
    expect(languages).toHaveLength(13);
    for (const language of languages) {
      const mu = JSON.parse(readFileSync(join(LOCALES, language, 'mu.json'), 'utf8')) as Record<string, unknown>;
      for (const code of MU_NOTICE_CODES) {
        const [, , key] = MU_NOTICE_KEYS[code].split('.');
        expect((mu.notices as Record<string, unknown> | undefined)?.[key], `${language} ${code}`).toEqual(
          expect.any(String)
        );
      }
    }
  });

  it('says it in the reader’s language', () => {
    const show = (lng: 'zh' | 'en', message: IMessageAcpToolCall) => {
      const i18n = createInstance();
      void i18n.init({
        lng,
        resources: { zh: { translation: { mu: zhMu } }, en: { translation: { mu: enMu } } },
        interpolation: { escapeValue: false },
      });
      const found = muNotice(message);
      if (!found) throw new Error('not a notice');
      return render(
        <I18nextProvider i18n={i18n}>
          <MessageMuNotice notice={found} />
        </I18nextProvider>
      );
    };
    const lost = notice({ title: MU_NOTICES.answer_lost, raw_input: { notice: 'answer_lost' } });
    const zh = show('zh', lost);
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(zhMu.notices.answerLost);
    zh.unmount();
    const en = show('en', lost);
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(MU_NOTICES.answer_lost);
    en.unmount();
    show('zh', notice({ title: 'Something new', raw_input: { notice: 'newer' } }));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent('Something new');
    expect(screen.queryByTestId('mu-notice-link')).toBeNull();
  });

  it('ends the line about Git for Windows with its download page, opened outside the app', () => {
    const i18n = createInstance();
    void i18n.init({
      lng: 'zh',
      resources: { zh: { translation: { mu: zhMu } } },
      interpolation: { escapeValue: false },
    });
    const found = muNotice(notice({ title: MU_NOTICES.bash_missing, raw_input: { notice: 'bash_missing' } }));
    if (!found) throw new Error('not a notice');
    render(
      <I18nextProvider i18n={i18n}>
        <MessageMuNotice notice={found} />
      </I18nextProvider>
    );
    const link = screen.getByTestId('mu-notice-link');
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(
      `${zhMu.notices.bashMissing} https://git-scm.com/download/win`
    );
    expect(link).toHaveAttribute('href', MU_NOTICE_LINKS.bash_missing);
    fireEvent.click(link);
    expect(openExternalUrl).toHaveBeenCalledWith('https://git-scm.com/download/win');
    // The bridge's own title carries the address too, for a client without these words.
    expect(MU_NOTICES.bash_missing).toContain('https://git-scm.com/download/win');
    expect(enMu.notices.bashMissing).not.toContain('http');
  });
});
