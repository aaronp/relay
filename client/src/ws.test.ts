import { expect, test } from 'bun:test';
import { subscribeUrl, tokenGoesInUrl } from './ws';

const args = { url: new URL('ws://h:1/'), nameOrAddress: 'db', authToken: 'JWT', wsProtocol: [], compression: 'none' as const, lightMode: false };

test('outside browsers the token is sent as a header, not in the URL', () => {
  expect(tokenGoesInUrl()).toBe(false);
  expect(subscribeUrl(args, false).searchParams.has('token')).toBe(false);
});

test('browsers (no header support) put it on the URL', () =>
  expect(subscribeUrl(args, true).searchParams.get('token')).toBe('JWT'));
