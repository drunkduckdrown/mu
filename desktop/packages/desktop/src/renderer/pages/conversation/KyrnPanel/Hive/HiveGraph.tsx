import React, { useId } from 'react';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { HiveBee } from '@/common/kyrn/hive';
import type { HiveDelivery } from './activity';
import BeeAvatar from './BeeAvatar';
import styles from './Hive.module.css';

export default function HiveGraph({
  bees,
  deliveries,
  selected,
  onSelect,
}: {
  bees: HiveBee[];
  deliveries: HiveDelivery[];
  selected?: string;
  onSelect: (name: string) => void;
}) {
  const { t } = useTranslation();
  const marker = `hive-arrow-${useId().replace(/:/g, '')}`;
  const height = Math.max(1, Math.ceil(bees.length / 2)) * 116 + 8;
  const positions = new Map(
    bees.map((bee, index) => [bee.name, { x: index % 2 === 0 ? 66 : 234, y: Math.floor(index / 2) * 116 + 30 }])
  );
  const edges = new Map<string, HiveDelivery>();
  for (const delivery of deliveries) {
    if (delivery.from !== delivery.to && positions.has(delivery.from) && positions.has(delivery.to)) {
      edges.set(JSON.stringify([delivery.from, delivery.to]), delivery);
    }
  }
  return (
    <section aria-label={t('common.kyrn.hiveView.graph')}>
      <div className={styles.graph} style={{ height }}>
        <svg className={styles.edges} viewBox={`0 0 300 ${height}`} preserveAspectRatio='none' aria-hidden='true'>
          <defs>
            <marker id={marker} markerWidth='7' markerHeight='7' refX='6' refY='3.5' orient='auto'>
              <path d='M0 0 L7 3.5 L0 7 Z' fill='currentColor' />
            </marker>
          </defs>
          {[...edges.entries()].map(([key, edge]) => {
            const from = positions.get(edge.from)!;
            const to = positions.get(edge.to)!;
            const fromX = from.x < 150 ? from.x + 28 : from.x - 28;
            const toX = to.x < 150 ? to.x + 30 : to.x - 30;
            const bend = edge.from < edge.to ? -14 : 14;
            return (
              <path
                key={key}
                data-testid='hive-connection'
                data-from={edge.from}
                data-to={edge.to}
                className={styles.edge}
                data-muted={Boolean(selected && selected !== edge.from && selected !== edge.to)}
                d={`M${fromX} ${from.y} C150 ${from.y + bend}, 150 ${to.y + bend}, ${toX} ${to.y}`}
                markerEnd={`url(#${marker})`}
              />
            );
          })}
        </svg>
        {bees.map((bee) => {
          const position = positions.get(bee.name)!;
          const status = t(
            bee.status === 'unknown' ? 'common.kyrn.hiveView.unknown' : `common.kyrn.beeStatus.${bee.status}`
          );
          return (
            <Button
              key={bee.name}
              type='text'
              className={styles.node}
              style={{ left: `${position.x / 3}%`, top: position.y - 22 }}
              aria-label={t('common.kyrn.hiveView.inspect', { name: bee.name })}
              aria-pressed={selected === bee.name}
              title={`${bee.name} · ${status}`}
              onClick={() => onSelect(bee.name)}
            >
              <BeeAvatar name={bee.name} status={bee.status} />
              <span className={styles.nodeName}>{bee.name}</span>
              <span className={styles.nodeStatus}>{status}</span>
            </Button>
          );
        })}
      </div>
      <p className={styles.hint}>{t('common.kyrn.hiveView.graphHint')}</p>
    </section>
  );
}
