/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Radio, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { systemSettings } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { isElectronDesktop } from '@/renderer/utils/platform';
import PreferenceRow from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/PreferenceRow';
import { SettingsPage } from './components/SettingsPageHeader';

/** The panel every row of this page sits on. */
const PANEL = 'px-16px md:px-24px py-4px bg-base border border-color-b-base rd-8px';

/**
 * The desktop pet, a page of its own: the switch on top. Its size, its do-not-disturb and its confirmation bubble
 * only appear once it is on — off, none of them mean anything.
 */
const PetSettings: React.FC = () => {
  const [enabled, setEnabled] = useState(false);
  const [enabledResolved, setEnabledResolved] = useState(false);
  const [size, setSize] = useState(280);
  const [dnd, setDnd] = useState(false);
  const [confirmEnabled, setConfirmEnabled] = useState(true);
  const { t } = useTranslation();
  const isDesktop = isElectronDesktop();

  useEffect(() => {
    let active = true;
    setSize(configService.get('pet.size') ?? 280);
    setDnd(configService.get('pet.dnd') ?? false);
    setConfirmEnabled(configService.get('pet.confirmEnabled') ?? true);
    systemSettings.getPetEnabled
      .invoke()
      .then((value) => {
        if (!active) return;
        setEnabled(value);
        setEnabledResolved(true);
      })
      .catch(() => {
        // IPC failure: fall back to the locked default (OFF); never fall back to ON,
        // which would reintroduce the "UI lies" state this fix eliminates.
        if (!active) return;
        setEnabled(false);
        setEnabledResolved(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleEnabledChange = useCallback((checked: boolean) => {
    setEnabled(checked);
    configService.setLocal('pet.enabled', checked);
    systemSettings.setPetEnabled.invoke({ enabled: checked }).catch(() => {
      setEnabled(!checked);
      configService.setLocal('pet.enabled', !checked);
    });
  }, []);

  const handleSizeChange = useCallback(
    (val: number) => {
      const prevSize = size;
      setSize(val);
      configService.setLocal('pet.size', val);
      systemSettings.setPetSize.invoke({ size: val }).catch(() => {
        setSize(prevSize);
        configService.setLocal('pet.size', prevSize);
      });
    },
    [size]
  );

  const handleDndChange = useCallback((checked: boolean) => {
    setDnd(checked);
    configService.setLocal('pet.dnd', checked);
    systemSettings.setPetDnd.invoke({ dnd: checked }).catch(() => {
      setDnd(!checked);
      configService.setLocal('pet.dnd', !checked);
    });
  }, []);

  const handleConfirmEnabledChange = useCallback((checked: boolean) => {
    setConfirmEnabled(checked);
    configService.setLocal('pet.confirmEnabled', checked);
    systemSettings.setPetConfirmEnabled.invoke({ enabled: checked }).catch(() => {
      setConfirmEnabled(!checked);
      configService.setLocal('pet.confirmEnabled', !checked);
    });
  }, []);

  if (!isDesktop) {
    return (
      <SettingsPage title={t('pet.desktopPet')}>
        <div className={PANEL}>
          <p className='my-12px text-13px text-t-secondary'>{t('pet.desktopOnly')}</p>
        </div>
      </SettingsPage>
    );
  }

  const preferenceItems: { key: string; label: string; description?: string; component: React.ReactNode }[] = [
    {
      key: 'enabled',
      label: t('pet.enable'),
      component: (
        <Switch
          size='small'
          checked={enabled}
          loading={!enabledResolved}
          disabled={!enabledResolved}
          onChange={handleEnabledChange}
        />
      ),
    },
    ...(enabled
      ? [
          {
            key: 'size',
            label: t('pet.size'),
            component: (
              <Radio.Group value={size} onChange={handleSizeChange} disabled={!enabled}>
                <Radio value={200}>{t('pet.sizeSmall', { px: 200 })}</Radio>
                <Radio value={280}>{t('pet.sizeMedium', { px: 280 })}</Radio>
                <Radio value={360}>{t('pet.sizeLarge', { px: 360 })}</Radio>
              </Radio.Group>
            ),
          },
          {
            key: 'dnd',
            label: t('pet.dnd'),
            description: t('pet.dndDescription'),
            component: <Switch size='small' checked={dnd} onChange={handleDndChange} disabled={!enabled} />,
          },
          {
            key: 'confirmBubble',
            label: t('pet.confirmBubble'),
            description: t('pet.confirmBubbleDescription'),
            component: (
              <Switch size='small' checked={confirmEnabled} onChange={handleConfirmEnabledChange} disabled={!enabled} />
            ),
          },
        ]
      : []),
  ];

  return (
    <SettingsPage title={t('pet.desktopPet')} data-testid='pet-settings'>
      <div className={PANEL}>
        <div className='w-full flex flex-col divide-y divide-b-base'>
          {preferenceItems.map((item) => (
            <PreferenceRow key={item.key} label={item.label} description={item.description}>
              {item.component}
            </PreferenceRow>
          ))}
        </div>
      </div>
    </SettingsPage>
  );
};

export default PetSettings;
