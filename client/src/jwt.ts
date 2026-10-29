// Unverified JWT decoding for display/scheduling only; the server does the real verification. Browser-safe.

export function decodePayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('malformed JWT');
  return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
}

/** `exp` (seconds since epoch) from a JWT. */
export function decodeExp(token: string): number {
  const exp = decodePayload(token).exp;
  if (typeof exp !== 'number') throw new Error('JWT has no exp');
  return exp;
}

/** Claim by literal key, then by dotted path (same rule as the module's readPolicySaids). */
export function claimValue(payload: Record<string, unknown>, key: string): unknown {
  if (key in payload) return payload[key];
  return key.split('.').reduce<unknown>(
    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), payload);
}

export function decodeClaims(token: string, claimKey = 'kerits.policySAIDs'): { sub: string; saids: string[]; exp: number } {
  const p = decodePayload(token);
  const v = claimValue(p, claimKey);
  return {
    sub: String(p.sub ?? ''),
    saids: Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [],
    exp: typeof p.exp === 'number' ? p.exp : 0,
  };
}
