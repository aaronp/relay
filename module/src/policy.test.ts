import { expect, test } from 'bun:test';
import { audienceAllowed, missingMessage, parseAddress, readPolicySaids, satisfies, validName } from './policy';

test('readPolicySaids flat key', () =>
  expect(readPolicySaids({ 'kerits.policySAIDs': ['A', 'B'] }, 'kerits.policySAIDs')).toEqual(['A', 'B']));

test('readPolicySaids nested path', () =>
  expect(readPolicySaids({ kerits: { policySAIDs: ['A'] } }, 'kerits.policySAIDs')).toEqual(['A']));

test('readPolicySaids missing or malformed -> []', () => {
  expect(readPolicySaids({}, 'kerits.policySAIDs')).toEqual([]);
  expect(readPolicySaids({ 'kerits.policySAIDs': 'A' }, 'kerits.policySAIDs')).toEqual([]);
  expect(readPolicySaids({ 'kerits.policySAIDs': ['A', 3] }, 'kerits.policySAIDs')).toEqual(['A']);
});

test('satisfies any-of', () => {
  expect(satisfies(['A', 'B'], ['B', 'C'])).toBe(true);
  expect(satisfies(['A'], ['C'])).toBe(false);
  expect(satisfies(['A'], [])).toBe(false);
});

test('validName', () => {
  for (const ok of ['example', 'a', 'kids-school_2']) expect(validName(ok)).toBe(true);
  for (const bad of ['', 'Ex', 'a.b', '-a', 'x'.repeat(65)]) expect(validName(bad)).toBe(false);
});

test('parseAddress', () => {
  expect(parseAddress('example.foo')).toEqual({ group: 'example', topic: 'foo' });
  expect(parseAddress('example')).toBeNull();
  expect(parseAddress('a.b.c')).toBeNull();
});

test('missingMessage', () => {
  expect(missingMessage('send', ['W', 'X'])).toBe('send requires one of [W, X]');
  expect(missingMessage('send', [])).toBe('send is not permitted');
});

test('audienceAllowed', () => {
  expect(audienceAllowed(['topics-cli'], [])).toBe(true); // empty allow-list = any (dev)
  expect(audienceAllowed(['topics-cli'], ['topics-cli', 'https://web'])).toBe(true);
  expect(audienceAllowed(['https://evil.example'], ['topics-cli'])).toBe(false);
  expect(audienceAllowed([], ['topics-cli'])).toBe(false);
});
