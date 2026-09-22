import React from 'react';
import { Button } from '@arco-design/web-react';
import { Bee, Right } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { isBeeActive, type HiveToolData } from '@/common/kyrn/hive';
import type { NormalizedToolStatus } from '@/common/chat/normalizeToolCall';
import { requestHiveFocus } from '../focus';
import BeeAvatar from './BeeAvatar';
import styles from './Hive.module.css';

export default function HiveToolCard({
  data,
  conversationId,
  runId,
  status,
}: {
  data: HiveToolData;
  conversationId?: string;
  runId: string;
  status: NormalizedToolStatus;
}) {
  const { t } = useTranslation();
  const bees = data.snapshot?.bees;
  const open = (beeName?: string) => {
    if (conversationId) requestHiveFocus({ conversationId, runId, beeName });
  };
  return (
    <section className={styles.toolCard} aria-label={t('common.kyrn.hiveView.title')}>
      <div className={styles.cardHeader}>
        <span className={styles.brandIcon}>
          <Bee size={22} />
        </span>
        <div className='flex-1 min-w-0'>
          <div className='font-600'>{t('common.kyrn.hiveView.title')}</div>
          <div className={styles.hint}>
            {bees
              ? t('common.kyrn.hiveView.summary', {
                  active: bees.filter((bee) => isBeeActive(bee.status)).length,
                  done: bees.filter((bee) => bee.status === 'done').length,
                  total: bees.length,
                })
              : t(
                  status === 'running' || status === 'pending'
                    ? 'common.kyrn.hiveView.pending'
                    : 'common.kyrn.hiveView.unknown'
                )}
          </div>
        </div>
        <Button
          type='text'
          size='small'
          disabled={!conversationId}
          onClick={() => open()}
          icon={<Right size={16} />}
          aria-label={t('common.kyrn.hiveView.open')}
        />
      </div>
      {data.goal && (
        <div className={styles.goal} title={data.goal}>
          {data.goal}
        </div>
      )}
      <div className={styles.chips}>
        {data.names.map((name, index) => {
          const bee = bees?.[index];
          return (
            <Button
              key={`${index}:${name}`}
              type='text'
              size='small'
              className={styles.chip}
              disabled={!conversationId}
              onClick={() => open(name)}
              aria-label={t('common.kyrn.hiveView.inspect', { name })}
            >
              <BeeAvatar name={name} status={bee?.status} small />
              <span className={styles.chipName}>{name}</span>
              {bee && (
                <span className={styles.hint}>
                  {t(bee.status === 'unknown' ? 'common.kyrn.hiveView.unknown' : `common.kyrn.beeStatus.${bee.status}`)}
                </span>
              )}
            </Button>
          );
        })}
      </div>
      <Button type='text' size='mini' className={styles.openLink} disabled={!conversationId} onClick={() => open()}>
        {t('common.kyrn.hiveView.open')} <Right size={12} />
      </Button>
    </section>
  );
}
