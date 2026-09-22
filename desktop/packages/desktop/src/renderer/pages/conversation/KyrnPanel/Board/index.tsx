import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Switch, Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import { emitter, type SendBoxCommandState } from '@/renderer/utils/emitter';
import { asksUser, boardView, share, type BoardUpdate } from './board';
import { boardWords, type BoardWords } from './wording';
import styles from './Board.module.css';

/** How long a sent switch waits for the session to say it switched before it can be used again. */
const SWITCH_WAIT_MS = 60_000;

/** A switch on its way: waiting for the agent to finish its turn, or sent and waiting for the session's answer. */
type Pending = { to: boolean; stage: 'waiting' | 'sent' };

/**
 * The plain-language board: where the work stands, in plain words, for the person and never for the model. The
 * harness writes it (Jev picks the facts, a plain-speaking model writes them up) and presents it; this shows the
 * latest one. The switch is the harness's own `/board on|off`, sent into the conversation like a typed command, so
 * the board stays per project and the app never writes its settings. It is offered only where the harness has said
 * it has a board: anywhere else the command would reach a model as a message.
 */
export default function Board({ events, conversationId }: { events: Activity[]; conversationId: string }) {
  const { t, i18n } = useTranslation();
  const view = useMemo(() => boardView(events), [events]);
  // A fixed board is rebuilt in the reader's language; a model's board is shown as it wrote it.
  const words = useMemo(
    () =>
      view.update
        ? boardWords(
            view.update,
            t,
            (key) => i18n.exists(key),
            (value) => formatNumber(value, i18n.language)
          )
        : undefined,
    [i18n, t, view.update]
  );
  const [pending, setPending] = useState<Pending>();
  const on = view.on ?? false;
  // The board that was there when the panel opened is not news (give the panel `key={conversationId}`), nor is the
  // one the session replays on opening: only a later one fades in and is read out.
  const opened = useRef(view.update?.id);
  const news = view.update && view.update.id !== opened.current && !view.update.restored ? view.update : undefined;

  useEffect(() => {
    if (!pending) return;
    if (view.on === pending.to) {
      setPending(undefined);
      return;
    }
    if (pending.stage !== 'sent') return;
    const timer = setTimeout(() => setPending(undefined), SWITCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending, view.on]);
  const turn = (to: boolean) => {
    setPending({ to, stage: 'sent' });
    const heard = (state: SendBoxCommandState) =>
      setPending((now) => (now?.to !== to ? now : state === 'dropped' ? undefined : { to, stage: state }));
    emitter.emit('sendbox.command', to ? '/board on' : '/board off', conversationId, heard);
  };
  const switching = pending !== undefined;

  return (
    <section className={styles.board} data-testid='mu-board' aria-label={t('common.kyrn.boardView.title')}>
      <header className={styles.head}>
        <span className={styles.title}>{t('common.kyrn.boardView.title')}</span>
        {pending ? (
          <span className={styles.faint} data-testid='mu-board-pending'>
            {t(pending.stage === 'waiting' ? 'common.kyrn.boardView.afterTurn' : 'common.kyrn.boardView.switching')}
          </span>
        ) : null}
        <Switch
          size='small'
          checked={pending ? pending.to : on}
          disabled={switching || !view.known}
          aria-label={t('common.kyrn.boardView.switch')}
          data-testid='mu-board-switch'
          onChange={turn}
        />
      </header>
      {!view.known ? (
        <p className={styles.empty} data-testid='mu-board-unknown'>
          {t('common.kyrn.boardView.unknown')}
        </p>
      ) : !on ? (
        <Off switching={switching} onOpen={() => turn(true)} />
      ) : view.update ? (
        <Current update={view.update} words={words ?? view.update} fresh={news === view.update} />
      ) : (
        <p className={styles.empty} data-testid='mu-board-empty'>
          {t('common.kyrn.boardView.empty')}
        </p>
      )}
      {/* In place from the start, so what changes in it is announced; only news goes in. One paragraph per part,
          read with a pause between them in any language: the model's lines bring their own punctuation. */}
      <div className={styles.announce} aria-live='polite' aria-atomic='true' data-testid='mu-board-announce'>
        {on && news && words
          ? [news.phase ? t(`common.kyrn.boardView.phases.${news.phase}`) : '', words.now, words.progress]
              .filter(Boolean)
              .map((part, index) => <p key={index}>{part}</p>)
          : null}
      </div>
    </section>
  );
}

function Off({ switching, onOpen }: { switching: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.off} data-testid='mu-board-off'>
      <p className={styles.offText}>{t('common.kyrn.boardView.off')}</p>
      <p className={styles.faint}>{t('common.kyrn.boardView.cost')}</p>
      <Button size='small' type='primary' disabled={switching} data-testid='mu-board-open' onClick={onOpen}>
        {t('common.kyrn.boardView.open')}
      </Button>
    </div>
  );
}

/**
 * The latest board, top to bottom: the stage, what the agent does now (the largest line), how far it is, and what
 * it needs from the person. A new one (`fresh`) fades in.
 */
function Current({ update, words, fresh }: { update: BoardUpdate; words: BoardWords; fresh: boolean }) {
  const { t, i18n } = useTranslation();
  const part = share(update);
  const checks = t('common.kyrn.boardView.checks', {
    done: formatNumber(update.done, i18n.language),
    total: formatNumber(update.total, i18n.language),
    count: update.total,
  });
  const quote = (item: string) =>
    emitter.emit('sendbox.reply', { messageId: `mu-board:${update.id}`, content: item, position: 'left' });
  return (
    <div className={styles.current} data-testid='mu-board-current'>
      <div className={styles.marks}>
        {update.phase ? (
          <span
            className={classNames(styles.phase, update.phase === 'stuck' && styles.stuck)}
            data-testid='mu-board-phase'
          >
            <span className={styles.phaseDot} aria-hidden='true' />
            {t(`common.kyrn.boardView.phases.${update.phase}`)}
          </span>
        ) : null}
        {update.ended ? <span className={styles.faint}>{t('common.kyrn.boardView.ended')}</span> : null}
        {update.by === 'rules' ? (
          <Tooltip content={t('common.kyrn.boardView.briefHelp')}>
            <span className={styles.brief}>{t('common.kyrn.boardView.brief')}</span>
          </Tooltip>
        ) : null}
      </div>
      <div key={update.id} className={classNames(fresh && styles.fresh)} data-fresh={fresh ? 'true' : undefined}>
        {words.now ? (
          <p className={styles.now} data-testid='mu-board-now'>
            {words.now}
          </p>
        ) : null}
        {words.progress ? (
          <p className={styles.progress} data-testid='mu-board-progress'>
            {words.progress}
          </p>
        ) : null}
      </div>
      {part !== undefined ? (
        <div className={styles.meter}>
          <div
            className={styles.bar}
            role='progressbar'
            aria-valuemin={0}
            aria-valuemax={update.total}
            aria-valuenow={update.done}
            aria-label={checks}
          >
            <span style={{ width: `${Math.round(part * 100)}%` }} />
          </div>
          <span className={styles.count}>{checks}</span>
        </div>
      ) : null}
      {asksUser(update) ? (
        <div className={styles.ask} data-testid='mu-board-ask'>
          <div className={styles.askTitle}>{t('common.kyrn.boardView.needsYou')}</div>
          {words.confirm.length ? (
            <>
              <ul className={styles.askList}>
                {words.confirm.map((item, index) => (
                  <li key={`${index}:${item}`}>
                    <button
                      type='button'
                      className={styles.askItem}
                      data-testid='mu-board-confirm'
                      title={t('common.kyrn.boardView.quote')}
                      onClick={() => quote(item)}
                    >
                      {item}
                    </button>
                  </li>
                ))}
              </ul>
              <div className={styles.faint}>{t('common.kyrn.boardView.quoteHint')}</div>
            </>
          ) : (
            <div className={styles.askText}>{t('common.kyrn.boardView.needsYouText')}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
