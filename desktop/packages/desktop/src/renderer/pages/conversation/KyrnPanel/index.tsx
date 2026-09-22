import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Collapse, Empty, Pagination, Space, Spin, Tabs, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import type { Activity } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import { thinkingLevelLabel } from '@/renderer/utils/model/thinkingLevel';
import { mergeActivity, list, record, str } from './activity';
import ContextPanel from './ContextPanel';
import Hive from './Hive';
import BeeActivityList from './Hive/BeeActivity';
import { beeErrorText, swarmTitleText } from './Hive/codes';
import { parseBeeActivity, parseBeeError, parseSwarmTitle } from '@/common/kyrn/hive';
import Board from './Board';
import { boardView } from './Board/board';
import Judge, { runtimeEvents } from './Judge';
import { stageOf } from './Judge/activity';
import { eventLines } from './Judge/eventLine';
import type { HiveFocusRequest } from './focus';
import { useClock } from './clock';
import { beeCounters, ErrorNotice, quietLabel } from './text';

export { onHiveFocus, requestHiveFocus, type HiveFocusRequest } from './focus';

function Payload({ value }: { value: unknown }) {
  // JSON reads left to right in every app language, including fa-IR.
  return (
    <pre className='m-0 text-12px whitespace-pre-wrap break-all text-t-secondary' dir='ltr'>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default function KyrnPanel({ conversationId, focus }: { conversationId: string; focus?: HiveFocusRequest }) {
  const { t, i18n } = useTranslation();
  const clock = useClock();
  const navigate = useNavigate();
  const [events, setEvents] = useState<Activity[]>([]);
  // The bridge's own message, shown under a translated headline; undefined while the activity loads fine.
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('hive');
  // Until the person picks a tab here, a board that is on for the project is what the panel opens on.
  const picked = useRef(false);
  const [page, setPage] = useState(1);
  const [expandedBees, setExpandedBees] = useState<Record<string, string[]>>({});
  const focusedRun = useRef<HTMLDivElement>(null);
  const scopedFocus = focus?.conversationId === conversationId ? focus : undefined;
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    let sessionId = '';
    setEvents([]);
    setLoading(true);
    setError(undefined);
    setPage(1);
    setExpandedBees({});
    picked.current = false;
    const poll = async () => {
      let delay = 1000;
      try {
        const result = unwrap(await kyrnBridge.activity.invoke({ conversationId, cursor, sessionId }));
        if (disposed) return;
        const changed = result.sessionId !== sessionId;
        sessionId = result.sessionId;
        cursor = result.cursor;
        setEvents((old) => mergeActivity(changed ? [] : old, result.events));
        setError(undefined);
        setLoading(false);
        if (result.more) delay = 0;
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [conversationId]);
  const snapshots = events.filter((event) => event.kind === 'swarm.snapshot' && event.payload.kind !== 'hive');
  const hiveRuns = useMemo(
    () =>
      new Set(
        events
          .filter(
            (event) =>
              event.kind === 'hive.manifest' || (event.kind === 'swarm.snapshot' && event.payload.kind === 'hive')
          )
          .map((event) => event.run)
      ),
    [events]
  );
  const focusAvailable =
    hiveRuns.has(scopedFocus?.runId) || snapshots.some((event) => event.run === scopedFocus?.runId);
  const boardOn = useMemo(() => boardView(events).on === true, [events]);
  useEffect(() => {
    if (boardOn && !picked.current && !scopedFocus) setTab('board');
  }, [boardOn, scopedFocus]);
  useEffect(() => {
    if (!scopedFocus) return;
    setTab('hive');
    setPage(1);
    if (scopedFocus.beeName) {
      setExpandedBees((old) => ({ ...old, [scopedFocus.runId]: [scopedFocus.beeName!] }));
    }
  }, [scopedFocus]);
  useEffect(() => {
    if (scopedFocus && focusAvailable && tab === 'hive') {
      focusedRun.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [scopedFocus, focusAvailable, tab]);
  const filtered = useMemo(
    () =>
      // The JeV tab shows judgments as cards; what is left for its list are the other runtime events. The board
      // tab has no list.
      tab === 'decisions'
        ? runtimeEvents(events)
        : tab === 'board'
          ? []
          : events.filter((event) =>
              tab === 'hive'
                ? (event.kind.startsWith('hive.') || event.kind === 'bee.event') && !hiveRuns.has(event.run)
                : tab === 'memory'
                  ? event.kind.startsWith('memory.') ||
                    (event.kind === 'decision' && str(event.payload.specId).startsWith('memory.'))
                  : event.kind === 'artifact.image'
            ),
    [events, tab, hiveRuns]
  );
  // A judgment is named by its question and a classification by its task type; the raw ids stay in the payload.
  const title = (event: Activity): string => {
    const specId = str(event.payload.specId);
    if (specId) return t(`common.kyrn.judgeView.questions.${stageOf(specId)}`);
    const turnType = str(event.payload.turnType);
    if (turnType)
      return /^[A-Za-z_]+$/.test(turnType)
        ? t(`common.kyrn.judgeView.values.${turnType}`, { defaultValue: turnType })
        : turnType;
    return t(`common.kyrn.event.${event.kind}`, { defaultValue: event.kind });
  };
  const notes = new Map(
    events.filter((e) => e.kind === 'hive.note').map((e) => [`${e.run}:${str(e.payload.id)}`, e.payload])
  );
  return (
    <div className='h-full min-h-0 flex flex-col text-t-primary' data-testid='kyrn-activity'>
      <div className='px-12px py-10px flex items-center justify-between'>
        <span className='font-600'>{t('common.kyrn.activity')}</span>
        <Button size='mini' type='text' onClick={() => void navigate('/settings/kyrn')}>
          {t('common.kyrn.settings')}
        </Button>
      </div>
      {error !== undefined && <ErrorNotice title={t('common.kyrn.activityLoadFailed')} detail={error} />}
      <ContextPanel events={events} />
      <Tabs
        activeTab={tab}
        size='small'
        onChange={(value) => {
          picked.current = true;
          setTab(value);
          setPage(1);
        }}
      >
        {['hive', 'decisions', 'memory', 'board', 'images'].map((key) => (
          <Tabs.TabPane key={key} title={key === 'board' ? t('common.kyrn.boardView.tab') : t(`common.kyrn.${key}`)} />
        ))}
      </Tabs>
      <div className='flex-1 min-h-0 overflow-y-auto px-12px pb-12px'>
        {loading && <Spin />}
        {tab === 'hive' && (!loading || scopedFocus) && (hiveRuns.size > 0 || !snapshots.length || scopedFocus) && (
          <div ref={hiveRuns.has(scopedFocus?.runId) ? focusedRun : undefined}>
            <Hive events={events} focus={scopedFocus} />
          </div>
        )}
        {tab === 'hive' &&
          snapshots.map((run) => (
            <div
              key={run.run}
              data-hive-run={run.run}
              ref={run.run === scopedFocus?.runId ? focusedRun : undefined}
              className='mb-16px'
            >
              <div className='font-500 mb-8px break-words'>{swarmTitleText(t, parseSwarmTitle(run.payload))}</div>
              <Collapse
                bordered={false}
                activeKey={expandedBees[run.run ?? ''] ?? []}
                onChange={(_key, keys) => setExpandedBees((old) => ({ ...old, [run.run ?? '']: keys }))}
              >
                {list(run.payload.bees).map((bee) => (
                  <Collapse.Item
                    key={str(bee.name)}
                    name={str(bee.name)}
                    header={
                      <Space>
                        <span>{str(bee.name)}</span>
                        <Tag>{t(`common.kyrn.beeStatus.${str(bee.status)}`, { defaultValue: str(bee.status) })}</Tag>
                      </Space>
                    }
                  >
                    <div className='text-13px mb-8px'>
                      {[str(bee.model), str(bee.thinking) && thinkingLevelLabel(t, str(bee.thinking))]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <div className='mb-8px'>{beeCounters(t, bee)}</div>
                    {bee.quietMs ? (
                      <Alert type='warning' content={quietLabel(t, Number(bee.quietMs), i18n.language)} />
                    ) : null}
                    {bee.error ? (
                      <ErrorNotice
                        title={t('common.kyrn.beeFailed')}
                        detail={beeErrorText(t, parseBeeError(bee), i18n.language)}
                      />
                    ) : null}
                    <div className='whitespace-pre-wrap break-words'>
                      {str(record(bee.tool).summary) || str(bee.said)}
                    </div>
                    <BeeActivityList entries={parseBeeActivity(bee.recent)} />
                  </Collapse.Item>
                ))}
              </Collapse>
            </div>
          ))}
        {tab === 'decisions' && !loading && <Judge events={events} />}
        {/* Kept while another tab is shown, so a switch on its way and what counts as new survive a look elsewhere. */}
        {!loading && (
          <div hidden={tab !== 'board'}>
            <Board key={conversationId} events={events} conversationId={conversationId} />
          </div>
        )}
        {!loading && !filtered.length && tab !== 'hive' && tab !== 'decisions' && tab !== 'board' && (
          <Empty description={t('common.kyrn.empty')} />
        )}
        {tab === 'decisions' && filtered.length > 0 && (
          <div className='mt-12px mb-4px text-12px font-600 text-t-secondary'>
            {t('common.kyrn.judgeView.runtimeEvents')} · {filtered.length}
          </div>
        )}
        <Collapse bordered={false}>
          {filtered.slice((page - 1) * 30, page * 30).map((event) => {
            const p = event.payload;
            const note = event.kind === 'hive.delivery' ? notes.get(`${event.run}:${str(p.note)}`) : undefined;
            const route =
              event.kind === 'hive.delivery'
                ? `${str(note?.bee)} → ${str(p.to)}`
                : event.kind === 'hive.gate'
                  ? `${str(p.bee) || str(p.from)}${p.to ? ` → ${str(p.to)}` : ''}`
                  : str(p.bee) || event.bee || '';
            const allowed = p.publish ?? p.deliver;
            // What the event says in the app language, by the harness's codes; other kinds keep the generic summary.
            const lines = eventLines(t, event.kind, p, i18n.language);
            return (
              <Collapse.Item
                key={event.id}
                name={event.id}
                header={
                  <div className='min-w-0'>
                    <div className='text-13px'>
                      {route} {title(event)}
                    </div>
                    <Space>
                      <span className='text-12px text-t-tertiary'>{clock(event.at)}</span>
                      {typeof allowed === 'boolean' && (
                        <Tag>{t(allowed ? 'common.kyrn.passed' : 'common.kyrn.filtered')}</Tag>
                      )}
                      {typeof p.score === 'number' && (
                        <span>
                          {formatNumber(p.score, i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      )}
                    </Space>
                  </div>
                }
              >
                {event.kind === 'artifact.image' && /^image\/(png|jpeg|webp|gif)$/.test(str(p.mimeType)) ? (
                  <img
                    alt={t('common.kyrn.image')}
                    src={`data:${str(p.mimeType)};base64,${str(p.data)}`}
                    className='max-w-full rounded-8px'
                  />
                ) : (
                  <>
                    <div className='whitespace-pre-wrap break-words mb-8px'>
                      {lines?.length
                        ? lines.map((line, index) => (
                            // A line may be data (a command, a server's words) in any script.
                            <div key={index} dir='auto'>
                              {line}
                            </div>
                          ))
                        : str(p.text) || str(p.lesson) || str(note?.text) || str(p.head)}
                    </div>
                    <Payload value={p} />
                  </>
                )}
              </Collapse.Item>
            );
          })}
        </Collapse>
        {filtered.length > 30 && (
          <Pagination
            simple
            current={page}
            pageSize={30}
            total={filtered.length}
            onChange={setPage}
            className='mt-12px'
          />
        )}
      </div>
    </div>
  );
}
