// Pure helpers: no SpacetimeDB imports, so they can be unit tested with bun.

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Policy SAIDs from a JWT payload. Tries the literal key, then the dotted path. Malformed -> []. */
export function readPolicySaids(payload: Record<string, unknown>, claimKey: string): string[] {
  let v: unknown = payload[claimKey];
  if (v === undefined) {
    v = claimKey.split('.').reduce<unknown>(
      (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      payload
    );
  }
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

export const satisfies = (saids: string[], required: string[]) => required.some(r => saids.includes(r));

export const validName = (name: string) => NAME.test(name);

export function parseAddress(addr: string): { group: string; topic: string } | null {
  const parts = addr.split('.');
  if (parts.length !== 2 || !validName(parts[0]) || !validName(parts[1])) return null;
  return { group: parts[0], topic: parts[1] };
}

export const missingMessage = (action: string, required: string[]) =>
  required.length ? `${action} requires one of [${required.join(', ')}]` : `${action} is not permitted`;

/** Empty allow-list accepts any audience (dev); otherwise the token must name one of them. */
export const audienceAllowed = (aud: readonly string[], allowed: string[]) =>
  allowed.length === 0 || aud.some(a => allowed.includes(a));
