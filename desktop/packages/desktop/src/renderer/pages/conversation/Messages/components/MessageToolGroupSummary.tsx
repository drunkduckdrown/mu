/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BadgeProps } from '@arco-design/web-react';
import { Badge, Button, Message, Tooltip } from '@arco-design/web-react';
import { Down, Download, Right } from '@icon-park/react';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { getAcpImageFileName } from '@/common/chat/acpToolCallOutput';
import type { NormalizedToolCall, NormalizedToolStatus, ToolMessage } from '@/common/chat/normalizeToolCall';
import { normalizeToolMessages } from '@/common/chat/normalizeToolCall';
import LocalImageView from '@/renderer/components/media/LocalImageView';
import { HiveToolCard } from '@/renderer/pages/conversation/KyrnPanel/Hive';
import { swarmProgressText } from '@/renderer/pages/conversation/KyrnPanel/Hive/codes';
import { formatNumber } from '@/renderer/services/i18n/format';
import { downloadFileFromPath } from '@/renderer/utils/file/download';
import styles from './MessageToolGroupSummary.module.css';
import ToolKindIcon from './ToolKindIcon';
import {
  clipOutput,
  shouldFoldActivity,
  summarizeToolActivity,
  toolActivityErrors,
  toolErrorLine,
  toolLabel,
  type ToolLabel,
} from './toolActivity';

const statusToBadge = (status: NormalizedToolStatus): BadgeProps['status'] => {
  switch (status) {
    case 'completed':
      return 'success';
    case 'error':
      return 'error';
    case 'running':
      return 'processing';
    case 'canceled':
    case 'pending':
    default:
      return 'default';
  }
};

/** `tools.status.*` uses the legacy tool-group wording for the same states. */
const statusLabelKey = (status: NormalizedToolStatus): string =>
  status === 'running' ? 'executing' : status === 'completed' ? 'success' : status;

/** "read src/a.ts", "bash npm test": what the reader sees on a folded line. */
const labelText = ({ verb, target }: ToolLabel): string => (target ? `${verb} ${target}` : verb);

const ClippedOutput: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const clip = useMemo(() => clipOutput(text), [text]);
  if (!clip.clipped) return <pre className={styles.detailContent}>{text}</pre>;
  return (
    <>
      <pre className={styles.detailContent}>{full ? text : `${clip.text}\n…`}</pre>
      <Button className={styles.moreButton} type='text' size='mini' onClick={() => setFull((value) => !value)}>
        {t(full ? 'tools.execution.showLess' : 'tools.execution.showMore')}
      </Button>
    </>
  );
};

const ToolItemDetail: React.FC<{ item: NormalizedToolCall }> = ({ item }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [fullItem, setFullItem] = useState<NormalizedToolCall | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const displayItem = fullItem ?? item;
  const label = toolLabel(displayItem);
  const statusKey = statusLabelKey(item.status);
  const hasDetail = Boolean(displayItem.input || displayItem.output || item.truncated || item.imagePath);
  const [messageApi, messageContext] = Message.useMessage();
  const handleDownloadImage = useCallback(
    async (path: string) => {
      try {
        await downloadFileFromPath(path, getAcpImageFileName(path));
        messageApi.success(t('acp.image.download_success'));
      } catch (error) {
        console.error('[MessageToolGroupSummary] Failed to download image:', error);
        messageApi.error(t('acp.image.download_error'));
      }
    },
    [messageApi, t]
  );

  const loadFullItem = async () => {
    if (!item.truncated || fullItem || loadingFull || !item.conversationId || !item.messageId) return;
    setLoadingFull(true);
    setLoadError(false);
    try {
      const message = await ipcBridge.database.getConversationMessage.invoke({
        conversation_id: item.conversationId,
        message_id: item.messageId,
      });
      const next = normalizeToolMessages([message as ToolMessage]).find((candidate) => candidate.key === item.key);
      if (next) setFullItem(next);
    } catch {
      setLoadError(true);
    } finally {
      setLoadingFull(false);
    }
  };

  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded) void loadFullItem();
  };

  const line = (
    <>
      <Badge status={statusToBadge(item.status)} className={item.status === 'running' ? styles.breathing : undefined} />
      <ToolKindIcon name={displayItem.name} />
      <span className={styles.callName}>{label.verb}</span>
      {label.target && <code className={styles.callPreview}>{label.target}</code>}
    </>
  );

  return (
    <div className={styles.call}>
      {messageContext}
      {displayItem.hive ? (
        <>
          <HiveToolCard
            data={displayItem.hive}
            conversationId={item.conversationId}
            runId={item.key}
            status={item.status}
          />
          {hasDetail && (
            <Button type='text' size='mini' aria-expanded={expanded} onClick={toggleExpanded}>
              {t('common.kyrn.hiveView.raw')}
            </Button>
          )}
        </>
      ) : hasDetail ? (
        <Button
          className={styles.callButton}
          type='text'
          size='mini'
          aria-label={t('tools.execution.callAria', { name: displayItem.name, status: t(`tools.status.${statusKey}`) })}
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          {line}
          {expanded ? <Down size={12} /> : <Right size={12} />}
        </Button>
      ) : (
        <div className={styles.callStatic}>{line}</div>
      )}
      {/* A failure says what went wrong without asking for a click. */}
      {item.status === 'error' && !expanded && !displayItem.hive && (
        <div className={styles.callError}>{toolErrorLine(displayItem)}</div>
      )}
      {expanded && hasDetail && (
        <div className={styles.detailPanel}>
          {loadingFull && <div className={styles.detailLabel}>{t('tools.execution.loading')}</div>}
          {loadError && (
            <div className={styles.loadError}>
              <span>{t('tools.execution.loadError')}</span>
              <Button type='text' size='mini' onClick={() => void loadFullItem()}>
                {t('tools.execution.retry')}
              </Button>
            </div>
          )}
          {displayItem.input && (
            <div className={styles.detailSection}>
              <div className={styles.detailLabel}>{t('tools.execution.input')}</div>
              <ClippedOutput text={displayItem.input} />
            </div>
          )}
          {displayItem.output && (
            <div className={styles.detailSection}>
              <div className={styles.detailLabel}>{t('tools.execution.output')}</div>
              <ClippedOutput text={swarmProgressText(t, displayItem.swarmProgress, displayItem.output)} />
            </div>
          )}
        </div>
      )}
      {item.imagePath && (
        <div className={styles.imagePreview}>
          <LocalImageView
            src={item.imagePath}
            alt={getAcpImageFileName(item.imagePath)}
            className='max-w-full max-h-320px object-contain rounded'
          />
          <Tooltip content={t('acp.image.download')}>
            <Button
              aria-label={t('acp.image.download_aria')}
              className={styles.downloadImage}
              type='secondary'
              size='mini'
              shape='circle'
              icon={<Download theme='outline' size='14' />}
              onClick={() => void handleDownloadImage(item.imagePath)}
            />
          </Tooltip>
        </div>
      )}
    </div>
  );
};

const ToolRows: React.FC<{ tools: NormalizedToolCall[] }> = ({ tools }) => (
  <>
    {tools.map((item) => (
      <ToolItemDetail key={item.key} item={item} />
    ))}
  </>
);

/**
 * A run of tool calls folded into one line: how many steps ran, and what is running right now. It opens in place to
 * the calls themselves and stays closed when the turn ends, so a finished reply reads as a reply. Failures never fold
 * away — each failed step keeps its own line under the closed header.
 */
const ToolActivityGroup: React.FC<{ tools: NormalizedToolCall[]; language?: string | null }> = ({
  tools,
  language,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => summarizeToolActivity(tools), [tools]);
  const errors = useMemo(() => toolActivityErrors(tools), [tools]);
  const steps = formatNumber(summary.steps, language);
  const headline =
    summary.status === 'running'
      ? t('tools.activity.running', { steps, label: summary.running ? labelText(summary.running) : '' })
      : summary.failed > 0
        ? t('tools.activity.summaryFailed', { steps, failed: formatNumber(summary.failed, language) })
        : t('tools.activity.summary', { steps });

  return (
    <div className={styles.activity} data-testid='tool-activity-group'>
      <Button
        className={styles.activityHeader}
        type='text'
        size='mini'
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Badge
          status={summary.status === 'running' ? 'processing' : summary.failed > 0 ? 'error' : 'default'}
          className={summary.status === 'running' ? styles.breathing : undefined}
        />
        <span className={styles.activitySummary}>{headline}</span>
        {expanded ? <Down size={12} /> : <Right size={12} />}
      </Button>
      {!expanded &&
        errors.map((error) => (
          <div key={error.key} className={styles.activityError} data-testid='tool-activity-error'>
            <span className={styles.callName}>{error.label.verb}</span>
            <span className={styles.activityErrorLine}>{error.line}</span>
          </div>
        ))}
      {expanded && (
        <div className={styles.activityBody}>
          <ToolRows tools={tools} />
        </div>
      )}
    </div>
  );
};

/**
 * The tools a stretch of the reply ran. One call is its own quiet line; several fold into one activity line that
 * opens to them (user, 2026-09-22: a "tool activity" header over a single call was one box too many).
 */
const MessageToolGroupSummary: React.FC<{ messages: ToolMessage[] }> = ({ messages }) => {
  const { t, i18n } = useTranslation();
  const tools = useMemo(() => normalizeToolMessages(messages), [messages]);
  if (!tools.length) return null;
  // A sub-agent run is its own panel, never a step in a fold.
  const folds = shouldFoldActivity(tools) && !tools.some((item) => item.hive);
  return (
    <div className={styles.summary} role='group' aria-label={t('tools.execution.title')}>
      {folds ? <ToolActivityGroup tools={tools} language={i18n?.language} /> : <ToolRows tools={tools} />}
    </div>
  );
};

export default React.memo(MessageToolGroupSummary);
