import React from 'react';
import classNames from 'classnames';
import styles from './sections.module.css';

type SectionShellProps = {
  id: string;
  title: string;
  description?: React.ReactNode;
  /** Right of the heading: a search box, an add button. */
  actions?: React.ReactNode;
  children: React.ReactNode;
};

/** Heading plus content of one section. The section is a size container: see sections.module.css. */
export default function SectionShell({ id, title, description, actions, children }: SectionShellProps) {
  return (
    <section className={styles.section} data-testid={`mu-section-${id}`} aria-label={title}>
      <div className={styles.heading}>
        <div className='min-w-0'>
          <h2 className={styles.title}>{title}</h2>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

type CardProps = {
  title?: React.ReactNode;
  badges?: React.ReactNode;
  /** Right end of the card head: a switch, a reset button. */
  extra?: React.ReactNode;
  summary?: React.ReactNode;
  dim?: boolean;
  testId?: string;
  children?: React.ReactNode;
};

export function Card({ title, badges, extra, summary, dim, testId, children }: CardProps) {
  const hasBody = React.Children.toArray(children).length > 0;
  return (
    <div className={styles.card} data-testid={testId}>
      {title ? (
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>{title}</span>
          {badges}
          <span className={styles.cardSpacer} />
          {extra}
        </div>
      ) : null}
      {summary ? <div className={styles.cardSummary}>{summary}</div> : null}
      {hasBody ? <div className={classNames(title && styles.cardBody, dim && styles.dim)}>{children}</div> : null}
    </div>
  );
}

export function GroupTitle({ children }: { children: React.ReactNode }) {
  return <h3 className={styles.groupTitle}>{children}</h3>;
}
