import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestVersion, updateMessage } from './version';

const DAY = 86_400_000;
const NOW = 10 * DAY;
const cacheFile = () => join(mkdtempSync(join(tmpdir(), 'relay-version-')), 'nested', 'update-check.json');
const npm = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const unreachable = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;

test('updateMessage only for a strictly newer version, compared numerically', () => {
  expect(updateMessage('0.9.0', '0.10.0')).toContain('0.9.0 -> 0.10.0');
  expect(updateMessage('0.9.0', '0.10.0')).toContain('bun install -g @aaronp/relay-cli');
  expect(updateMessage('0.10.0', '0.10.0')).toBeUndefined();
  expect(updateMessage('0.10.0', '0.9.0')).toBeUndefined();
  expect(updateMessage('0.10.0', undefined)).toBeUndefined();
});

test('latestVersion asks npm, then answers from the cache for a day', async () => {
  const file = cacheFile();
  expect(await latestVersion(file, NOW, npm({ version: '1.2.3' }))).toBe('1.2.3');
  expect(await latestVersion(file, NOW + DAY - 1, unreachable)).toBe('1.2.3');
  expect(await latestVersion(file, NOW + DAY, npm({ version: '1.2.4' }))).toBe('1.2.4');
});

test('latestVersion survives failures, keeps the last answer and waits a day to retry', async () => {
  const file = cacheFile();
  expect(await latestVersion(file, NOW, unreachable)).toBeUndefined();
  expect(JSON.parse(readFileSync(file, 'utf8')).checkedAt).toBe(NOW);
  await latestVersion(file, NOW + DAY, npm({ version: '1.2.3' }));
  expect(await latestVersion(file, NOW + 2 * DAY, unreachable)).toBe('1.2.3');
  expect(await latestVersion(file, NOW + 3 * DAY, npm({ error: 'not found' }, 404))).toBe('1.2.3');
});

test('latestVersion ignores a version that is not plain semver, and a corrupt cache', async () => {
  const file = cacheFile();
  expect(await latestVersion(file, NOW, npm({ version: '\x1b[31mrun this' }))).toBeUndefined();
  writeFileSync(file, 'not json');
  expect(await latestVersion(file, NOW, npm({ version: '1.2.3' }))).toBe('1.2.3');
});
