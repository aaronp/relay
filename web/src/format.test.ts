import { expect, test } from 'bun:test';
import { displayPayload, parseSaids } from './format';

test('parseSaids', () => expect(parseSaids(' A, ,B ,A,')).toEqual(['A', 'B']));

test('displayPayload', () => {
  expect(displayPayload(new TextEncoder().encode('héllo'))).toBe('héllo');
  expect(displayPayload(new TextEncoder().encode('a\nb'))).toBe('a\\x0ab');
  expect(displayPayload(new Uint8Array([0xff, 0x00, 0x10]))).toBe('hex:ff0010');
});
