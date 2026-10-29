import { expect, test } from 'bun:test';

test('built bundle has no node/bun-only APIs', async () => {
  const js = await Bun.file(new URL('../dist/index.js', import.meta.url)).text();
  for (const bad of ['from "fs"', 'node:', 'process.', 'Bun.']) expect(js).not.toContain(bad);
});
