/** `exp` (seconds since epoch) from a JWT, without verifying it. Browser-safe (atob). */
export function decodeExp(token: string): number {
  const part = token.split('.')[1];
  if (!part) throw new Error('malformed JWT');
  const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  if (typeof payload.exp !== 'number') throw new Error('JWT has no exp');
  return payload.exp;
}
