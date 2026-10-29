import { parseAddress } from '../../module/src/policy';

/** `{"read-policy":"X","write-policy":["A","B"]}` -> { 'read-policy': ['X'], 'write-policy': ['A','B'] } */
export function parsePermissions(json: string, keys: string[]): Record<string, string[]> {
  let obj: unknown;
  try { obj = JSON.parse(json); } catch { throw new Error(`--permissions must be JSON, e.g. {"${keys[0]}":"SAID"}`); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('--permissions must be a JSON object');
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) throw new Error(`unknown permission "${k}" (expected one of ${keys.join(', ')})`);
    const list = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(list) || !list.every(s => typeof s === 'string'))
      throw new Error(`permission "${k}" must be a SAID string or an array of them`);
    out[k] = list;
  }
  return out;
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** `30s|15m|12h|7d` -> seconds */
export function parseLifetime(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`invalid lifetime "${s}" (use e.g. 30s, 15m, 12h, 7d)`);
  return Number(m[1]) * UNITS[m[2]];
}

export function parseTopicAddr(s: string): string {
  if (!parseAddress(s)) throw new Error(`invalid topic "${s}" (expected group.topic, lowercase a-z 0-9 _ -)`);
  return s;
}
