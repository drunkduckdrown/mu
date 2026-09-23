/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import ConversationPreferences from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/ConversationPreferences';
import { SettingsPage } from '../components/SettingsPageHeader';

/** What a conversation may wait for and keep: its time limits, the preview's size limit, uploads, cross-talk. */
const ConversationSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t('settings.conversations')} description={t('settings.conversationsDescription')}>
      <ConversationPreferences />
    </SettingsPage>
  );
};

export default ConversationSettings;
