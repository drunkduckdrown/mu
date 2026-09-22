import type { BadgeProps } from '@arco-design/web-react';
import { Badge, Button, Message, Spin, Tooltip } from '@arco-design/web-react';
import { Checklist, Down, Download, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { getAcpImageFileName } from '@/common/chat/acpToolCallOutput';
import type { NormalizedToolCall, NormalizedToolStatus, ToolMessage } from '@/common/chat/normalizeToolCall';
import { normalizeToolMessages } from '@/common/chat/normalizeToolCall';
import LocalImageView from '@/renderer/components/media/LocalImageView';
import { HiveToolCard } from '@/renderer/pages/conversation/KyrnPanel/Hive';
import { downloadFileFromPath } from '@/renderer/utils/file/download';
import styles from './MessageToolGroupSummary.module.css';

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

/**
 * One status for the collapsed box. Work in progress wins; a failure must stay visible after the
 * run so a collapsed box never reads as clean, and a stale pending call must not hide it.
 */
const groupStatus = (items: NormalizedToolCall[]): NormalizedToolStatus =>
  (['running', 'error', 'pending', 'canceled'] as const).find((status) =>
    items.some((item) => item.status === status)
  ) ?? 'completed';

const inputPreview = (input?: string): string | undefined => {
  if (!input) return undefined;
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of ['command', 'file_path', 'path', 'query', 'pattern', 'url']) {
        if (typeof record[key] === 'string') return record[key];
      }
    }
  } catch {
    return input.split('\n', 1)[0];
  }
  return undefined;
};

const itemPreview = (item: NormalizedToolCall): string | undefined => inputPreview(item.input) || item.description;

const isCommand = (item: NormalizedToolCall): boolean => {
  if (/\b(shell|command|execute|terminal|bash|powershell|cmd)\b/i.test(item.name)) return true;
  return Boolean(item.input && /"command"\s*:/i.test(item.input));
};

const ToolItemDetail: React.FC<{ item: NormalizedToolCall }> = ({ item }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [fullItem, setFullItem] = useState<NormalizedToolCall | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const displayItem = fullItem ?? item;
  const preview = itemPreview(displayItem);
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
          <Badge
            status={statusToBadge(item.status)}
            className={item.status === 'running' ? styles.breathing : undefined}
          />
          <span className={styles.callName}>{displayItem.name}</span>
          {preview && <code className={styles.callPreview}>{preview}</code>}
          {expanded ? <Down size={12} /> : <Right size={12} />}
        </Button>
      ) : (
        <div className={styles.callStatic}>
          <Badge
            status={statusToBadge(item.status)}
            className={item.status === 'running' ? styles.breathing : undefined}
          />
          <span className={styles.callName}>{displayItem.name}</span>
          {preview && <code className={styles.callPreview}>{preview}</code>}
        </div>
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
              <pre className={styles.detailContent}>{displayItem.input}</pre>
            </div>
          )}
          {displayItem.output && (
            <div className={styles.detailSection}>
              <div className={styles.detailLabel}>{t('tools.execution.output')}</div>
              <pre className={styles.detailContent}>{displayItem.output}</pre>
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

const MessageToolGroupSummary: React.FC<{ messages: ToolMessage[] }> = ({ messages }) => {
  const { t } = useTranslation();
  const tools = useMemo(() => normalizeToolMessages(messages), [messages]);
  const ordinaryTools = tools.filter((item) => !item.hive);
  const hasRunning = ordinaryTools.some((item) => item.status === 'running');
  const [showMore, setShowMore] = useState(false);

  useEffect(() => {
    if (hasRunning) setShowMore(true);
  }, [hasRunning]);

  const latestTool = ordinaryTools.findLast((item) => item.status === 'running') ?? ordinaryTools.at(-1);
  const latestPreview = latestTool ? itemPreview(latestTool) : undefined;
  const commandCount = ordinaryTools.filter(isCommand).length;
  const status = groupStatus(ordinaryTools);

  return (
    <div className={styles.summary}>
      {tools
        .filter((item) => item.hive)
        .map((item) => (
          <ToolItemDetail key={item.key} item={item} />
        ))}
      {ordinaryTools.length > 0 && (
        <>
          <Button
            className={styles.header}
            type='secondary'
            size='mini'
            aria-expanded={showMore}
            onClick={() => setShowMore((value) => !value)}
          >
            <span className={styles.headerIcon}>
              {hasRunning ? <Spin size={12} /> : <Checklist theme='outline' size='14' />}
            </span>
            <span>{t('tools.execution.title')}</span>
            <span className={styles.status} data-status={status}>
              <Badge status={statusToBadge(status)} className={status === 'running' ? styles.breathing : undefined} />
              <span>{t(`tools.status.${statusLabelKey(status)}`)}</span>
            </span>
            <span className={styles.counts}>
              <span>
                {t('tools.execution.calls', { count: ordinaryTools.length })}
                {commandCount > 0 && ' ·'}
              </span>
              {commandCount > 0 && (
                <>
                  {' '}
                  <span>{t('tools.execution.commands', { count: commandCount })}</span>
                </>
              )}
            </span>
            {latestTool && (
              <span className={styles.latest} title={latestPreview}>
                <span>{latestTool.name}</span>
                {latestPreview && <code>{latestPreview}</code>}
              </span>
            )}
            <span className={showMore ? styles.arrowOpen : styles.arrow}>
              <Right theme='outline' size='12' />
            </span>
          </Button>
          {showMore && (
            <div className={styles.body} role='group' aria-label={t('tools.execution.title')}>
              {ordinaryTools.map((item) => (
                <ToolItemDetail key={item.key} item={item} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default React.memo(MessageToolGroupSummary);
