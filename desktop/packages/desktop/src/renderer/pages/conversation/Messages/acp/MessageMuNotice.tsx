import { Attention } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { openExternalUrl } from '@/renderer/utils/platform';
import { MU_NOTICE_KEYS, MU_NOTICE_LINKS, type MuNotice } from './muNotice';
import styles from './MessageJevLine.module.css';

/**
 * A notice of the mu bridge as one line in the reader's language, such as an answer to mu's question that did not reach
 * it. Quiet like Jev's lines, with a warning mark: it says what mu did in the person's place, or what the person has to
 * do (ending with the page to do it on).
 */
export default function MessageMuNotice({ notice }: { notice: MuNotice }) {
  const { t } = useTranslation();
  const text = notice.code ? t(MU_NOTICE_KEYS[notice.code]) : notice.title;
  const link = notice.code ? MU_NOTICE_LINKS[notice.code] : undefined;
  if (!text) return null;
  return (
    <div className={styles.line} role='status' data-testid='mu-notice' data-code={notice.code ?? ''}>
      <Attention theme='outline' size='14' className='flex-none text-warning' aria-hidden='true' />
      <span className='min-w-0 whitespace-normal'>
        {text}
        {link && (
          <>
            {' '}
            <a
              href={link}
              className='break-all text-primary'
              data-testid='mu-notice-link'
              onClick={(event) => {
                event.preventDefault();
                void openExternalUrl(link);
              }}
            >
              {link}
            </a>
          </>
        )}
      </span>
    </div>
  );
}
