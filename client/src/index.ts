import { DbConnection } from './bindings';
import { directTokenSocket } from './ws';

export { decodeExp } from './jwt';

export type ConnectOptions = { uri: string; db: string; token: string };

export type TopicInfo = {
  address: string;
  name: string;
  group: string;
  owner: string;
  readPolicies: string[];
  writePolicies: string[];
  expiresAt?: Date;
};

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const toDate = (ts: { microsSinceUnixEpoch: bigint }) => new Date(Number(ts.microsSinceUnixEpoch / 1000n));

export class Client {
  constructor(readonly conn: DbConnection) {}

  createGroup(name: string, opts: { createTopicPolicies: string[] }): Promise<void> {
    return this.conn.reducers.createGroup({ name, createTopicPolicies: opts.createTopicPolicies });
  }

  createTopic(
    addr: string,
    opts: { readPolicies: string[]; writePolicies: string[]; lifetimeSecs?: number }
  ): Promise<void> {
    return this.conn.reducers.createTopic({
      address: addr,
      readPolicies: opts.readPolicies,
      writePolicies: opts.writePolicies,
      lifetimeSecs: opts.lifetimeSecs === undefined ? undefined : BigInt(opts.lifetimeSecs),
    });
  }

  send(addr: string, payload: Uint8Array): Promise<void> {
    return this.conn.reducers.send({ address: addr, payload: Array.from(payload) });
  }

  async listTopics(group: string): Promise<TopicInfo[]> {
    const rows = await this.#snapshot(`SELECT * FROM topic WHERE group_name = ${sqlString(group)}`,
      () => [...this.conn.db.topic.iter()].filter(t => t.groupName === group));
    return rows.map(t => ({
      address: t.address,
      name: t.name,
      group: t.groupName,
      owner: t.owner,
      readPolicies: t.readPolicies,
      writePolicies: t.writePolicies,
      expiresAt: t.expiresAt ? toDate(t.expiresAt) : undefined,
    }));
  }

  /** Subscribe, read the applied rows, unsubscribe. */
  #snapshot<T>(sql: string, read: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      const handle = this.conn.subscriptionBuilder()
        .onApplied(() => { const rows = read(); handle.unsubscribe(); resolve(rows); })
        .onError(ctx => reject(ctx.event ?? new Error('subscription failed')))
        .subscribe(sql);
    });
  }

  close() {
    this.conn.disconnect();
  }
}

/** Resolves once connected; rejects with the server's reason (bad issuer, expired token, ...). */
export function connect(opts: ConnectOptions): Promise<Client> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(opts.uri)
      .withDatabaseName(opts.db)
      .withToken(opts.token)
      .withCompression('none')
      .withWSFn(directTokenSocket)
      .onConnect(conn => resolve(new Client(conn)))
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect((_ctx, err) => reject(err ?? new Error('disconnected')))
      .build();
  });
}
