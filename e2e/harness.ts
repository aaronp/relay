// e2e precondition: `spacetime start --listen-addr 127.0.0.1:3010` is running (the CLI's `local` server).
import { startDevIssuer } from '../dev-issuer/src/issuer';

export const URI = process.env.TOPICS_TEST_URI ?? 'ws://127.0.0.1:3010';
const SERVER = process.env.TOPICS_TEST_SERVER ?? 'local';
const ROOT = new URL('..', import.meta.url).pathname;

// SpacetimeDB caches JWKS per issuer URL and the dev key is fresh per run, so use a fresh port per run.
let issuerPort = 20000 + Math.floor(Math.random() * 20000);

function run(args: string[]) {
  const p = Bun.spawnSync(['spacetime', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`spacetime ${args.join(' ')} failed:\n${p.stderr}${p.stdout}`);
  return p.stdout.toString();
}

/** Fresh database + dev issuer per test file; config points at the issuer with createGroupPolicy ONBOARDED. */
export async function setup() {
  const iss = await startDevIssuer({ port: issuerPort++ });
  const db = `topics-test-${Math.random().toString(36).slice(2, 10)}`;
  try {
    run(['publish', '-s', SERVER, db, '--module-path', 'module', '-y']);
  } catch (e) {
    iss.stop();
    throw new Error(`could not publish to SpacetimeDB "${SERVER}" — is \`spacetime start\` running?\n${e}`);
  }
  run(['call', '-s', SERVER, db, 'set_config', iss.issuer, 'ONBOARDED', 'kerits.policySAIDs', '["topics-dev"]']);
  return {
    uri: URI,
    db,
    issuer: iss,
    tokenFor: (sub: string, saids: string[], ttlSec = 3600) => iss.mint({ sub, saids, ttlSec }),
    teardown() {
      iss.stop();
      try { run(['delete', '-s', SERVER, db, '-y']); } catch {}
    },
  };
}
