import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { LOCAL_JUDGE_DOWNLOAD_MB, type LocalJudgeAction, type LocalJudgeState } from '@/common/kyrn/localJudge';
import { formatNumber } from '@/renderer/services/i18n/format';
import { openExternalUrl } from '@/renderer/utils/platform';
import MuErrorMessage from '../fields/MuErrorMessage';
import { toMuError, type MuError } from '../fields/muError';
import { StatusDot, type DotState } from '../providers/parts';
import styles from './sections.module.css';

const UV_URL = 'https://docs.astral.sh/uv/getting-started/installation/';

/**
 * Laya on this machine: whether it is installed and running, and one click to install it (after the person agrees to
 * the download), start it or stop it. Applies at once, outside the save bar: it is a program, not a setting.
 */
export default function LocalJudgePanel() {
  const { t, i18n } = useTranslation();
  const [modal, modalHolder] = Modal.useModal();
  const [state, setState] = useState<LocalJudgeState>();
  const [problem, setProblem] = useState<MuError>();
  const live = useRef(true);
  const read = useCallback(async () => {
    try {
      const next = unwrap(await kyrnBridge.localJudgeState.invoke());
      if (live.current) setState(next);
    } catch (error) {
      if (live.current) setProblem(toMuError(error));
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void read();
    return () => {
      live.current = false;
    };
  }, [read]);

  const task = state?.task;
  const busy = task?.phase === 'running';
  // The script moves on by itself: its state is read while it runs.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void read(), 1000);
    return () => clearInterval(timer);
  }, [busy, read]);

  const run = async (action: LocalJudgeAction, consent = false) => {
    setProblem(undefined);
    try {
      const next = unwrap(await kyrnBridge.localJudgeRun.invoke({ action, consent }));
      if (live.current) setState(next);
    } catch (error) {
      if (live.current) setProblem(toMuError(error));
    }
  };
  const install = () =>
    modal.confirm?.({
      title: t('mu.judges.laya.confirmTitle'),
      content: t('mu.judges.laya.confirmText', { size: formatNumber(LOCAL_JUDGE_DOWNLOAD_MB, i18n.language) }),
      okText: t('mu.judges.laya.confirmOk'),
      cancelText: t('common.cancel'),
      onOk: () => void run('setup', true),
    });

  if (!state)
    return problem ? (
      <div className={styles.choiceHint} role='alert'>
        <MuErrorMessage error={problem} />
      </div>
    ) : null;

  const dot: DotState = busy ? 'busy' : state.running ? 'ready' : state.installed ? 'off' : 'attention';
  const status = busy
    ? t(`mu.judges.laya.working.${task.action}`)
    : state.running
      ? t('mu.judges.laya.running')
      : state.installed
        ? t('mu.judges.laya.stopped')
        : state.support === 'platform'
          ? t('mu.judges.laya.platform')
          : state.support === 'uv'
            ? t('mu.judges.laya.needsUv')
            : t('mu.judges.laya.missing');
  const failed = task?.phase === 'failed';

  return (
    <div className={styles.localJudge} data-testid='mu-laya'>
      {modalHolder}
      <div className={styles.localJudgeStatus} data-testid='mu-laya-status'>
        <StatusDot state={dot} label={status} />
        <span>{status}</span>
      </div>
      <div className={styles.localJudgeActions}>
        {!state.installed && state.support === 'ok' ? (
          <Button
            size='small'
            type='primary'
            loading={busy}
            disabled={busy}
            data-testid='mu-laya-install'
            onClick={install}
          >
            {t('mu.judges.laya.install')}
          </Button>
        ) : null}
        {!state.installed && state.support === 'uv' ? (
          <Button size='small' data-testid='mu-laya-uv' onClick={() => void openExternalUrl(UV_URL)}>
            {t('mu.judges.laya.uvLink')}
          </Button>
        ) : null}
        {state.installed && !state.running ? (
          <Button
            size='small'
            type='primary'
            loading={busy}
            disabled={busy}
            data-testid='mu-laya-start'
            onClick={() => void run('start')}
          >
            {t('mu.judges.laya.start')}
          </Button>
        ) : null}
        {state.running ? (
          <Button
            size='small'
            loading={busy}
            disabled={busy}
            data-testid='mu-laya-stop'
            onClick={() => void run('stop')}
          >
            {t('mu.judges.laya.stop')}
          </Button>
        ) : null}
      </div>
      {failed ? (
        <div className={styles.localJudgeProblem} role='alert' data-testid='mu-laya-failed'>
          {t(`mu.judges.laya.failed.${task.action}`)}
        </div>
      ) : null}
      {(busy || failed) && task.output.length ? (
        <pre className={styles.localJudgeOutput} dir='ltr' data-testid='mu-laya-output'>
          {task.output.slice(busy ? -2 : -6).join('\n')}
        </pre>
      ) : null}
      {problem ? (
        <div className={styles.localJudgeProblem} role='alert'>
          <MuErrorMessage error={problem} />
        </div>
      ) : null}
    </div>
  );
}
