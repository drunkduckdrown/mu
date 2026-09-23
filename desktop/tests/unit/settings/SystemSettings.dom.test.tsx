/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import SystemSettings from '@/renderer/pages/settings/SystemSettings';
import AboutSettings from '@/renderer/pages/settings/SystemSettings/AboutSettings';
import BrowserSettings from '@/renderer/pages/settings/SystemSettings/BrowserSettings';
import ConversationSettings from '@/renderer/pages/settings/SystemSettings/ConversationSettings';
import VoiceSettings from '@/renderer/pages/settings/SystemSettings/VoiceSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/renderer/components/settings/SettingsModal/contents/SystemModalContent', () => ({
  default: () => <div data-testid='system-modal-content'>SystemModalContent</div>,
}));
vi.mock('@/renderer/components/settings/SettingsModal/contents/SystemModalContent/ConversationPreferences', () => ({
  default: () => <div data-testid='conversation-preferences' />,
}));
vi.mock('@/renderer/components/settings/SettingsModal/contents/SystemModalContent/VoiceInputSection', () => ({
  default: () => <div data-testid='voice-input-section' />,
}));
vi.mock('@/renderer/components/settings/SettingsModal/contents/SystemModalContent/BrowserDataSection', () => ({
  default: () => <div data-testid='browser-data-section' />,
}));
vi.mock('@/renderer/components/settings/SettingsModal/contents/AboutModalContent', () => ({
  default: () => <div data-testid='about-modal-content'>AboutModalContent</div>,
}));

vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children, contentClassName }: { children: React.ReactNode; contentClassName?: string }) => (
    <div data-testid='settings-page-wrapper' {...(contentClassName ? { 'data-content-class': contentClassName } : {})}>
      {children}
    </div>
  ),
}));

describe('the pages that were one long system page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['system', SystemSettings, 'settings.system', 'system-modal-content'],
    ['conversations', ConversationSettings, 'settings.conversations', 'conversation-preferences'],
    ['voice input', VoiceSettings, 'settings.voiceInput', 'voice-input-section'],
    ['in-app browser', BrowserSettings, 'settings.browserData.title', 'browser-data-section'],
    ['about', AboutSettings, 'settings.about', 'about-modal-content'],
  ])('gives the %s its own page, titled, in the page frame with no width of its own', (_name, Page, title, content) => {
    render(<Page />);
    const wrapper = screen.getByTestId('settings-page-wrapper');
    expect(wrapper).not.toHaveAttribute('data-content-class');
    expect(within(wrapper).getByRole('heading', { name: title })).toBeInTheDocument();
    expect(within(wrapper).getByTestId(content)).toBeInTheDocument();
  });

  it('keeps About and the conversation rows off the system page: they are pages of their own now', () => {
    render(<SystemSettings />);
    expect(screen.getByTestId('system-modal-content')).toBeInTheDocument();
    expect(screen.queryByTestId('about-modal-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('conversation-preferences')).not.toBeInTheDocument();
  });
});
