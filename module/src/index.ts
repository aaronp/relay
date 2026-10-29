import { schema, table, t } from 'spacetimedb/server';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

const config = table(
  { name: 'config' },
  {
    id: t.u32().primaryKey(),
    trustedIssuer: t.string(),
  }
);

const spacetimedb = schema({ config });
export default spacetimedb;

export const init = spacetimedb.init(ctx => {
  ctx.db.config.insert({ id: 0, trustedIssuer: bytesToHex(sha256(new Uint8Array())) });
});
