import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Config = {
  server: string;
  db: string;
  issuer: string;
  port: number;
  token?: string;
  refreshToken?: string;
  /** true when the token came from TOPICS_TOKEN (don't refresh or persist it) */
  tokenFromEnv?: boolean;
};

type Stored = Partial<Omit<Config, 'tokenFromEnv'>>;

const DEFAULTS = {
  server: 'wss://maincloud.spacetimedb.com',
  db: 'topics',
  issuer: 'https://oauth.kerits.id',
  port: 7863,
};

const file = () => join(homedir(), '.config', 'topics-chat', 'config.json');

function readStored(): Stored {
  try { return existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {}; } catch { return {}; }
}

/** Precedence: flag > env > config file > defaults. */
export function loadConfig(flags: { server?: string; db?: string; issuer?: string; port?: string }): Config {
  const s = readStored();
  const env = process.env;
  const envToken = env.TOPICS_TOKEN;
  return {
    server: flags.server ?? env.TOPICS_SERVER ?? s.server ?? DEFAULTS.server,
    db: flags.db ?? env.TOPICS_DB ?? s.db ?? DEFAULTS.db,
    issuer: flags.issuer ?? env.TOPICS_ISSUER ?? s.issuer ?? DEFAULTS.issuer,
    port: Number(flags.port ?? env.TOPICS_AUTH_PORT ?? s.port ?? DEFAULTS.port),
    token: envToken ?? s.token,
    refreshToken: envToken ? undefined : s.refreshToken,
    tokenFromEnv: !!envToken,
  };
}

/** Persists server/db/issuer/port and tokens, mode 0600 (it holds bearer tokens). */
export function saveConfig(cfg: Config) {
  const { tokenFromEnv: _, ...stored } = cfg;
  mkdirSync(dirname(file()), { recursive: true, mode: 0o700 });
  writeFileSync(file(), JSON.stringify(stored, null, 2), { mode: 0o600 });
  chmodSync(file(), 0o600);
}
