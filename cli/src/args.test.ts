import { expect, test } from 'bun:test';
import { parseLifetime, parsePermissions, parseTopicAddr } from './args';

test('parsePermissions single and array', () =>
  expect(parsePermissions('{"read-policy":"XYZ","write-policy":["HKI","Q"]}', ['read-policy', 'write-policy']))
    .toEqual({ 'read-policy': ['XYZ'], 'write-policy': ['HKI', 'Q'] }));

test('parsePermissions unknown key', () =>
  expect(() => parsePermissions('{"reed":"X"}', ['read-policy'])).toThrow('unknown permission "reed"'));

test('parsePermissions rejects non-string values', () =>
  expect(() => parsePermissions('{"read-policy":3}', ['read-policy'])).toThrow());

test('parseLifetime', () => {
  expect(parseLifetime('7d')).toBe(604800);
  expect(parseLifetime('30s')).toBe(30);
  expect(parseLifetime('15m')).toBe(900);
  expect(parseLifetime('12h')).toBe(43200);
  expect(() => parseLifetime('7 days')).toThrow();
});

test('parseTopicAddr', () => {
  expect(parseTopicAddr('example.foo')).toBe('example.foo');
  expect(() => parseTopicAddr('example')).toThrow();
});
