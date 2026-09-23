/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import VoiceInputSection from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/VoiceInputSection';
import { SettingsPage } from '../components/SettingsPageHeader';

/** Speaking instead of typing: the switch on top, the service and its key under it once it is on. */
const VoiceSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t('settings.voiceInput')}>
      <VoiceInputSection />
    </SettingsPage>
  );
};

export default VoiceSettings;
