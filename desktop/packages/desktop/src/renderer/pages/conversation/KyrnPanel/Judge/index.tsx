import React, { useMemo, useState } from 'react';
import { Empty, Pagination, Select } from '@arco-design/web-react';
import { BalanceTwo } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import { judgeCards, type JudgeStage } from './activity';
import JudgeCardView from './JudgeCardView';
import styles from './Judge.module.css';

export { runtimeEvents } from './activity';

const PAGE_SIZE = 20;
const ALL = 'all';

/**
 * Recorded judgments as "what was judged, what the verdict was, what it did to execution".
 * It shows decisions and their recorded effects only: no model request text, no live terminal, and
 * no savings figure that was not measured.
 */
export default function Judge({ events }: { events: Activity[] }) {
  const { t, i18n } = useTranslation();
  const cards = useMemo(() => judgeCards(events), [events]);
  const stages = useMemo(() => [...new Set(cards.map((card) => card.stage))], [cards]);
  const [picked, setPicked] = useState<JudgeStage | typeof ALL>(ALL);
  const [page, setPage] = useState(1);
  // A stage can vanish when the panel attaches to another session; the filter must not strand the list.
  const stage = picked !== ALL && stages.includes(picked) ? picked : ALL;
  const shown = stage === ALL ? cards : cards.filter((card) => card.stage === stage);
  const current = Math.min(page, Math.max(1, Math.ceil(shown.length / PAGE_SIZE)));
  const stats = [
    { key: 'records', value: cards.length },
    // Handed over is not carried out: only a recorded effect or a delivery receipt counts as confirmed.
    { key: 'returnedCount', value: cards.filter((card) => ['returned', 'confirmed'].includes(card.state)).length },
    { key: 'receiptCount', value: cards.filter((card) => card.action === 'delivered').length },
  ];

  return (
    <section className={styles.judge} data-testid='kyrn-judge'>
      <div className={styles.header}>
        <span className={styles.brandIcon}>
          <BalanceTwo size={22} />
        </span>
        <div className='min-w-0 flex-1'>
          <h3 className={styles.title}>{t('common.kyrn.judgeView.title')}</h3>
          <div className={styles.hint}>{t('common.kyrn.judgeView.description')}</div>
        </div>
      </div>
      {!cards.length ? (
        <Empty description={t('common.kyrn.judgeView.empty')} />
      ) : (
        <>
          <dl className={styles.stats}>
            {stats.map((stat) => (
              <div key={stat.key} className={styles.stat}>
                <dt>{t(`common.kyrn.judgeView.${stat.key}`)}</dt>
                <dd className={styles.statValue}>{formatNumber(stat.value, i18n.language)}</dd>
              </div>
            ))}
          </dl>
          {stages.length > 1 && (
            <Select
              aria-label={t('common.kyrn.judgeView.filter')}
              className={styles.filter}
              size='small'
              value={stage}
              options={[
                { value: ALL, label: `${t('common.kyrn.judgeView.allQuestions')} · ${cards.length}` },
                ...stages.map((value) => ({
                  value,
                  label: `${t(`common.kyrn.judgeView.questions.${value}`)} · ${cards.filter((card) => card.stage === value).length}`,
                })),
              ]}
              onChange={(value: JudgeStage | typeof ALL) => {
                setPicked(value);
                setPage(1);
              }}
            />
          )}
          {shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE).map((card) => (
            <JudgeCardView key={card.id} card={card} />
          ))}
          {shown.length > PAGE_SIZE && (
            <Pagination simple current={current} pageSize={PAGE_SIZE} total={shown.length} onChange={setPage} />
          )}
        </>
      )}
    </section>
  );
}
