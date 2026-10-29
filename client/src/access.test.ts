import { expect, test } from 'bun:test';
import { topicAccess } from './access';

test('topicAccess', () => {
  const t = { owner: 'bob', readPolicies: ['R'], writePolicies: ['W', 'X'] };
  expect(topicAccess({ sub: 'a', saids: ['R'] }, t)).toEqual({ read: true, write: false });
  expect(topicAccess({ sub: 'a', saids: ['X'] }, t)).toEqual({ read: false, write: true });
  expect(topicAccess({ sub: 'bob', saids: [] }, t)).toEqual({ read: true, write: true });
  expect(topicAccess({ sub: 'a', saids: ['R'] }, { owner: 'bob', readPolicies: [], writePolicies: [] }))
    .toEqual({ read: false, write: false });
});
