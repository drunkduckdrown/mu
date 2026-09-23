/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import SystemModalContent from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent';
import { SettingsPage } from '../components/SettingsPageHeader';

/**
 * The machine underneath: starting with the computer, closing to the tray, graphics acceleration, notifications, and
 * the folders mu works and logs in.
 */
const SystemSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t('settings.system')}>
      <SystemModalContent />
    </SettingsPage>
  );
};

export default SystemSettings;
