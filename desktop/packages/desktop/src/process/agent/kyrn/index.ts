import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KyrnAgent } from './KyrnAgent.ts';
import { muHome } from './naming.ts';

const root = resolve(process.env.KYRN_ROOT || fileURLToPath(new URL('../../../../../../../KYRN', import.meta.url)));
let agent: KyrnAgent;
const connection = new AgentSideConnection(
  (conn) => {
    // The old launcher path forwards to `mu`, and exists in checkouts from before the rename too.
    agent = new KyrnAgent(conn, join(root, 'kyrn/bin/kyrn'), join(muHome(), 'acp-sessions'));
    return agent;
  },
  // Node and lib.dom describe BYOB readers differently; both are WHATWG streams at runtime.
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>)
);
void connection.closed.then(() => agent.close());
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    agent.close();
    process.exit(0);
  });
