// Small pure helpers shared by the CLI and web UI.

/** Mirrors the module rule: owner always passes; otherwise any-of; an empty list means owner-only. */
export function topicAccess(
  claims: { sub: string; saids: string[] },
  topic: { owner: string; readPolicies: string[]; writePolicies: string[] }
): { read: boolean; write: boolean } {
  const ok = (required: string[]) => claims.sub === topic.owner || required.some(r => claims.saids.includes(r));
  return { read: ok(topic.readPolicies), write: ok(topic.writePolicies) };
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** `30s|15m|12h|7d` -> seconds */
export function parseLifetime(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`invalid lifetime "${s}" (use e.g. 30s, 15m, 12h, 7d)`);
  return Number(m[1]) * UNITS[m[2]];
}

/** C0/C1 control chars and DEL as \xNN, so message text can't fake lines or send terminal escapes. */
export const displayText = (text: string) =>
  text.replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
