/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SpeechToTextConfig } from '@/common/types/provider/speech';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enSettings from '@/renderer/services/i18n/locales/en-US/settings.json';
import zhConversation from '@/renderer/services/i18n/locales/zh-CN/conversation.json';
import zhSettings from '@/renderer/services/i18n/locales/zh-CN/settings.json';

const speech = vi.hoisted(() => ({
  onTranscript: undefined as ((text: string) => void) | undefined,
  state: {
    availability: 'microphone',
    clearError: () => {},
    errorCode: null as string | null,
    errorMessage: null as string | null,
    startRecording: async () => {},
    status: 'idle',
    stopRecording: () => {},
    transcribeFile: async () => {},
    recordingDurationMs: 0,
  },
}));

vi.mock('@/renderer/hooks/system/useSpeechInput', () => ({
  getSpeechInputErrorMessageKey: () => 'conversation.chat.speech.networkError',
  useSpeechInput: ({ onTranscript }: { onTranscript: (text: string) => void }) => {
    speech.onTranscript = onTranscript;
    return speech.state;
  },
}));

vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: vi.fn(),
  setClientBusinessSetting: vi.fn(() => Promise.resolve()),
  removeClientBusinessSetting: vi.fn(() => Promise.resolve()),
}));

import SpeechTestPanel from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/VoiceInputSection/SpeechTestPanel';

const config: SpeechToTextConfig = {
  enabled: true,
  provider: 'openai',
  openai: { api_key: 'sk-test', base_url: '', model: 'gpt-4o-transcribe', language: '' },
};

const instance = async (lng: string, translation: Record<string, unknown>): Promise<I18n> => {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: 'en-US',
    resources: { [lng]: { translation } },
    interpolation: { escapeValue: false },
  });
  return i18n;
};

let english: I18n;
let chinese: I18n;
beforeAll(async () => {
  english = await instance('en-US', { settings: enSettings, conversation: enConversation });
  chinese = await instance('zh-CN', { settings: zhSettings, conversation: zhConversation });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  speech.state.errorCode = null;
  speech.state.errorMessage = null;
});

const show = (i18n: I18n) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SpeechTestPanel config={config} source='openai' />
    </I18nextProvider>
  );

const transcribe = async (i18n: I18n, text: string) => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  show(i18n);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(speech.onTranscript).toBeDefined());
  // Let the click handler record the start time before the transcript arrives.
  await act(async () => {});
  now.mockReturnValue(11_400);
  act(() => speech.onTranscript?.(text));
};

describe('SpeechTestPanel result and errors', () => {
  it('shows the result as one sentence with the elapsed time in the app language', async () => {
    await transcribe(english, 'hello there');
    expect(screen.getByText('Result (1.4 sec): hello there')).toBeTruthy();
  });

  it('keeps Chinese punctuation inside the translation', async () => {
    await transcribe(chinese, '你好');
    expect(screen.getByText('识别结果（1.4秒）：你好')).toBeTruthy();
  });

  it('shows the service reason as a detail under the translated headline', () => {
    speech.state.errorCode = 'network';
    speech.state.errorMessage = 'upstream 502 Bad Gateway';
    show(english);
    expect(screen.getByText('Network error while transcribing audio')).toBeTruthy();
    expect(screen.getByText('upstream 502 Bad Gateway')).toBeTruthy();
    expect(screen.queryByText(/Network error while transcribing audio: /)).toBeNull();
  });
});
