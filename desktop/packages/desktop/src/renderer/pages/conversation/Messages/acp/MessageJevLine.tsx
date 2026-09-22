import React from 'react';
import { useTranslation } from 'react-i18next';
import { isTurnType, type JevLine } from './jevLine';
import styles from './MessageJevLine.module.css';

/**
 * Jev's classification of the message, as one quiet line in the person's own language ("Jev 归类为闲聊"), in place of
 * a tool call box. Shadow and late verdicts say they were not used; a rule's class says so.
 */
export default function MessageJevLine({ line }: { line: JevLine }) {
  const { t } = useTranslation();
  let text: string;
  if (line.stage === 'classifying') text = t('common.kyrn.jevLine.classifying');
  else if (line.stage === 'fallback') text = t('common.kyrn.jevLine.fallback');
  else {
    const type = t(`common.kyrn.judgeView.values.${isTurnType(line.turnType) ? line.turnType : 'other'}`);
    const said = t(line.byRule ? 'common.kyrn.jevLine.byRule' : 'common.kyrn.jevLine.classified', { type });
    text =
      line.state === 'shadow'
        ? t('common.kyrn.jevLine.shadow', { line: said })
        : line.state === 'late'
          ? t('common.kyrn.jevLine.late', { line: said })
          : said;
  }
  const muted = line.stage === 'fallback' || (line.stage === 'classified' && line.state !== 'applied');
  return (
    <div className={styles.line} data-testid='mu-jev-line' data-stage={line.stage}>
      <span
        className={line.stage === 'classifying' ? styles.dotBusy : muted ? styles.dotMuted : styles.dot}
        aria-hidden='true'
      />
      <span className={styles.text}>{text}</span>
    </div>
  );
}
