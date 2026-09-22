const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

const BEE_STATUSES = [
  'queued',
  'starting',
  'thinking',
  'tool',
  'retrying',
  'wrapping-up',
  'done',
  'failed',
  'stopped',
  'timed-out',
] as const;
export type HiveBeeStatus = (typeof BEE_STATUSES)[number] | 'unknown';
export type HiveBee = {
  name: string;
  assignmentIndex: number;
  status: HiveBeeStatus;
  role: string;
  model: string;
  thinking: string;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  published: number;
  received: number;
  said: string;
  error: string;
  quietMs: number;
  tool?: { name: string; summary: string };
};
export type HiveSnapshot = {
  title: string;
  bees: HiveBee[];
  startedAt: number;
  endedAt: number;
  now: number;
};
export type HiveToolData = { goal: string; names: string[]; snapshot?: HiveSnapshot };

/** Decode only display fields; paths and arbitrary tool metadata never reach the native view. */
export function parseHiveSnapshot(value: unknown): HiveSnapshot | undefined {
  const row = record(value);
  if (row.kind !== 'hive' || !Array.isArray(row.bees)) return undefined;
  const names = new Set<string>();
  const bees = row.bees.flatMap((item, assignmentIndex): HiveBee[] => {
    const bee = record(item);
    const name = text(bee.name);
    if (!name || names.has(name)) return [];
    names.add(name);
    const tool = record(bee.tool);
    const status = text(bee.status);
    return [
      {
        name,
        assignmentIndex,
        status: BEE_STATUSES.find((known) => known === status) ?? 'unknown',
        role: text(bee.role),
        model: text(bee.model),
        thinking: text(bee.thinking),
        turns: number(bee.turns),
        toolCalls: number(bee.toolCalls),
        toolErrors: number(bee.toolErrors),
        published: number(bee.published),
        received: number(bee.received),
        said: text(bee.said),
        error: text(bee.error),
        quietMs: number(bee.quietMs),
        tool: text(tool.name) ? { name: text(tool.name), summary: text(tool.summary) } : undefined,
      },
    ];
  });
  return {
    title: text(row.title),
    bees,
    startedAt: number(row.startedAt),
    endedAt: number(row.endedAt),
    now: number(row.now),
  };
}

/** Keep structured Hive data alongside the unchanged generic input/output evidence. */
export function parseHiveTool(title: string, input: unknown, output: unknown): HiveToolData | undefined {
  const snapshot = parseHiveSnapshot(record(record(output).details).snapshot);
  if (!snapshot && title !== 'hive') return undefined;
  const args = record(input);
  return {
    snapshot,
    goal: text(args.goal) || snapshot?.title || '',
    names:
      snapshot?.bees.map((bee) => bee.name) ??
      (Array.isArray(args.bees) ? args.bees.map((bee) => text(record(bee).name)).filter(Boolean) : []),
  };
}

export function isBeeActive(status: HiveBeeStatus): boolean {
  return ['starting', 'thinking', 'tool', 'retrying', 'wrapping-up'].includes(status);
}
