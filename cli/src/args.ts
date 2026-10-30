import { parseAddress } from '../../module/src/policy';

export { displayText, parseLifetime } from '@pritzlaff/relay-client';

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

export function parseTopicAddr(s: string): string {
  if (!parseAddress(s)) throw new Error(`invalid topic "${s}" (expected group.topic, lowercase a-z 0-9 _ -)`);
  return s;
}
