/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Switch, Message } from '@arco-design/web-react';
import { FolderOpen, Github, Right } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import MuMark from '@renderer/components/brand/MuMark';
import { useTranslation } from 'react-i18next';
import classNames from 'classnames';
import { useSettingsViewMode } from '../settingsViewContext';
import { isElectronDesktop, openExternalUrl } from '@/renderer/utils/platform';
import { ipcBridge } from '@/common';
import {
  describeUpdateError,
  getIncludePrerelease,
  runUpdateCheck,
} from '@/renderer/components/settings/checkForUpdatesShared';
import { UPDATE_AVAILABLE_EVENT } from '@/renderer/components/settings/useUpdateNotificationController';
import {
  getUpdateReadyState,
  setUpdateReadyState,
  subscribeUpdateReadyState,
  type UpdateReadyState,
} from '@/renderer/components/settings/updateReadyState';

// Both are injected by electron.vite.config.ts `define:`. __MU_VERSION__ is mu's own version
// (packages/desktop/package.json), the one shown here; __APP_VERSION__ is the fork's (the repo-root
// package.json), the update check's fallback when the main process cannot say.
declare const __APP_VERSION__: string;
declare const __MU_VERSION__: string;

const MU_REPO_URL = 'https://github.com/qybaihe/mu';
const MU_RELEASES_URL = 'https://github.com/qybaihe/mu/releases';

type LinkItem = { title: string; icon: React.ReactNode; open: () => void };

const AboutModalContent: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const isElectron = isElectronDesktop();

  const [includePrerelease, setIncludePrerelease] = useState(false);
  const [updateReadyState, setLocalUpdateReadyState] = useState<UpdateReadyState>(() => getUpdateReadyState());
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('update.includePrerelease');
    setIncludePrerelease(saved === 'true');
  }, []);

  useEffect(() => subscribeUpdateReadyState(setLocalUpdateReadyState), []);

  const handlePrereleaseChange = (val: boolean) => {
    setIncludePrerelease(val);
    localStorage.setItem('update.includePrerelease', String(val));
  };

  const openLink = async (url: string) => {
    try {
      await openExternalUrl(url);
    } catch (error) {
      console.log('Failed to open link:', error);
    }
  };

  const checkUpdate = async () => {
    if (updateReadyState.ready) {
      if (updateReadyState.preparing) return;
      if (updateReadyState.filePath) {
        void ipcBridge.shell.openFile.invoke(updateReadyState.filePath);
        return;
      }
      setUpdateReadyState({ ...updateReadyState, preparing: true });
      void ipcBridge.autoUpdate.quitAndInstall.invoke().catch(() => {
        Message.error(t('update.errors.prepareInstallFailed'));
        setUpdateReadyState({ ...updateReadyState, preparing: false });
      });
      return;
    }

    if (checking) return;
    setChecking(true);
    try {
      const outcome = await runUpdateCheck({
        includePrerelease: getIncludePrerelease(),
        fallbackVersion: __APP_VERSION__,
      });
      if (outcome.kind === 'available') {
        // Only reveal the bottom-right card once an update is confirmed; hand
        // over the already-fetched outcome so the card skips the checking flash.
        window.dispatchEvent(new CustomEvent(UPDATE_AVAILABLE_EVENT, { detail: outcome }));
      } else if (outcome.kind === 'upToDate') {
        Message.info(t('update.alreadyLatest'));
      } else {
        Message.error(describeUpdateError(t, outcome.error, 'update.checkFailed'));
      }
    } finally {
      setChecking(false);
    }
  };

  // Only the desktop app has a log folder to open.
  const openLogFolder = window.electronAPI?.openLogFolder;
  const linkItems: LinkItem[] = [
    {
      title: t('common.github'),
      icon: <Github theme='outline' size='16' />,
      open: () => void openLink(MU_REPO_URL).catch((error) => console.error('Failed to open link:', error)),
    },
    {
      title: t('settings.updateLog'),
      icon: <Right theme='outline' size='16' className='rtl-mirror' />,
      open: () => void openLink(MU_RELEASES_URL).catch((error) => console.error('Failed to open link:', error)),
    },
    ...(openLogFolder
      ? [
          {
            title: t('common.backendStartup.openLogs'),
            icon: <FolderOpen theme='outline' size='16' />,
            open: () => {
              void openLogFolder().catch(() => {
                Message.error(t('common.backendStartup.openLogsFailed'));
              });
            },
          },
        ]
      : []),
  ];

  const version = `v${__MU_VERSION__}`;
  const rowClass = 'flex min-h-48px items-center justify-between gap-24px py-10px';
  const rowTitleClass = 'text-14px font-500 text-t-primary';

  return (
    <div
      className={classNames('flex w-full flex-col gap-16px', !isPageMode && 'px-24px pb-16px')}
      data-testid='about-content'
    >
      {/* Which mu this is: the mark and the name, set on the left like every settings page. In the app the version
          heads the update row, beside the button that checks it; elsewhere it sits by the name. */}
      <div className='flex items-center gap-16px'>
        <MuMark size={48} halo />
        <div className='flex min-w-0 flex-col gap-4px'>
          <div className='flex items-center gap-8px'>
            <span className='text-18px font-600 leading-24px text-t-primary'>mu</span>
            {isElectron ? null : (
              <span
                className='rd-6px bg-fill-2 px-8px py-2px text-12px font-500 text-t-secondary'
                data-testid='about-version'
              >
                {version}
              </span>
            )}
          </div>
          <span className='text-13px text-t-secondary'>{t('common.kyrn.brand.tagline')}</span>
        </div>
      </div>

      <div className='flex flex-col divide-y divide-b-base rd-8px border border-solid border-[var(--border-base)] bg-base px-16px'>
        {isElectron ? (
          <>
            <div className={rowClass}>
              <span className={rowTitleClass} data-testid='about-version'>
                {t('update.currentVersion', { version })}
              </span>
              <Button
                type={updateReadyState.ready ? 'primary' : 'secondary'}
                size='small'
                loading={checking || updateReadyState.preparing}
                disabled={updateReadyState.preparing}
                onClick={() => void checkUpdate()}
              >
                {updateReadyState.preparing
                  ? t('update.preparingInstall')
                  : updateReadyState.ready
                    ? t('settings.updateReadyInstall', { version: updateReadyState.version })
                    : checking
                      ? t('settings.checkingForUpdates')
                      : t('settings.checkForUpdates')}
              </Button>
            </div>
            <div className={rowClass}>
              <span className={rowTitleClass}>{t('settings.includePrereleaseUpdates')}</span>
              <Switch size='small' checked={includePrerelease} onChange={handlePrereleaseChange} />
            </div>
          </>
        ) : null}
        {linkItems.map((item) => (
          <div
            key={item.title}
            role='button'
            tabIndex={0}
            className={classNames(rowClass, 'group cursor-pointer')}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              item.open();
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              item.open();
            }}
          >
            <span className={rowTitleClass}>{item.title}</span>
            <span className='flex text-t-secondary transition-colors group-hover:text-t-primary'>{item.icon}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AboutModalContent;
