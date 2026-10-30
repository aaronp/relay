import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import pkg from '../package.json';

/** The git SHA, stamped by --define at build time. Absent when running from source. */
declare const RELAY_SHA: string | undefined;
const SHA = typeof RELAY_SHA === 'string' ? RELAY_SHA : undefined;

export const VERSION = `${pkg.version} (${SHA ?? 'source'})`;

const LATEST_URL = `https://registry.npmjs.org/${pkg.name}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 1000;
const CACHE_FILE = join(homedir(), '.config', 'relay', 'update-check.json');

export function updateMessage(current: string, latest?: string): string | undefined {
  if (!latest || Bun.semver.order(latest, current) !== 1) return undefined;
  return `a new version of relay is available (${current} -> ${latest}), run: bun install -g ${pkg.name}`;
}

/** The newest published version, asking npm at most once a day. Never throws: this must not break a command. */
export async function latestVersion(file = CACHE_FILE, now = Date.now(), fetcher: typeof fetch = fetch): Promise<string | undefined> {
  let cached: { checkedAt?: number; latest?: string } = {};
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (now - (cached.checkedAt ?? 0) < CHECK_INTERVAL_MS) return cached.latest;
  let latest = cached.latest;
  try {
    const res = await fetcher(LATEST_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const { version } = await res.json() as { version?: unknown };
    if (res.ok && typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version)) latest = version;
  } catch {}
  // Stamped even after a failure, so being offline slows at most one command a day.
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ checkedAt: now, latest }));
  } catch {}
  return latest;
}

/** For people at a terminal running a build: never from source, in scripts, or with RELAY_NO_UPDATE_CHECK=1. */
export async function checkForUpdate(): Promise<void> {
  if (!SHA || !process.stderr.isTTY || process.env.RELAY_NO_UPDATE_CHECK === '1') return;
  const message = updateMessage(pkg.version, await latestVersion());
  if (message) console.error(message);
}
