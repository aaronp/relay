import { displayText } from '@aaronp/relay-client';

/** "A, ,B ,A," -> ['A', 'B'] */
export const parseSaids = (input: string) => [...new Set(input.split(',').map(s => s.trim()).filter(Boolean))];

/** UTF-8 text (control chars escaped), or hex:… when the bytes aren't valid UTF-8. */
export function displayPayload(b: Uint8Array): string {
  try {
    return displayText(new TextDecoder('utf-8', { fatal: true }).decode(b));
  } catch {
    return `hex:${Array.from(b, x => x.toString(16).padStart(2, '0')).join('')}`;
  }
}
