import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHarness, launcherOf, MIN_NODE, nodeVersionOk } from './harness.ts';
import { KyrnAgent } from './KyrnAgent.ts';
import { muHome } from './naming.ts';

// Run from the desktop's sources (scripts/kyrn/acp) this file knows its checkout. Bundled into the packaged app
// (out/main/mu-acp.js, see scripts/build-mcp-servers.js) there is none: `import.meta` is empty there.
const source: string | undefined = import.meta.url;
const desktopRoot =
  process.env.KYRN_DESKTOP_ROOT ||
  (source?.startsWith('file:') ? fileURLToPath(new URL('../../../../../../', source)) : undefined);
if (!nodeVersionOk(process.versions.node)) {
  process.stderr.write(
    `mu needs Node.js ${MIN_NODE.join('.')} or newer, found ${process.versions.node}. Install it from https://nodejs.org\n`
  );
  process.exit(1);
}
// No harness found: the launcher of the old default place, whose failure to start the app reports as mu offline.
const harness = findHarness(desktopRoot) ?? {
  root: resolve(desktopRoot ?? process.cwd(), '..', 'KYRN'),
  layout: 'repo' as const,
};
let agent: KyrnAgent;
const connection = new AgentSideConnection(
  (conn) => {
    agent = new KyrnAgent(conn, launcherOf(harness, process.platform), join(muHome(), 'acp-sessions'));
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
