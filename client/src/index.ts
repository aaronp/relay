import { DbConnection } from './bindings';
import { decodeExp } from './jwt';
import { directTokenSocket } from './ws';

export { decodeExp } from './jwt';

export type ConnectOptions = {
  uri: string;
  db: string;
  token: string;
  /** Called when the token expires. Return a fresh token to reconnect (watches resume), or undefined to stop. */
  onExpired?: () => Promise<string | undefined>;
};

export type TopicInfo = {
  address: string;
  name: string;
  group: string;
  owner: string;
  readPolicies: string[];
  writePolicies: string[];
  expiresAt?: Date;
};

export type Envelope = {
  id: bigint;
  group: string;
  topic: string;
  sentAt: Date;
  sender: string;
  digest: string;
  payload: Uint8Array;
};

type MessageRow = {
  id: bigint; topicId: bigint; group: string; topic: string;
  sentAt: { microsSinceUnixEpoch: bigint }; sender: string; digest: string; payload: Uint8Array;
};

type Watch = { addr: string; onMessage: (e: Envelope) => void; seen: Set<bigint>; stop?: () => void };

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const toDate = (ts: { microsSinceUnixEpoch: bigint }) => new Date(Number(ts.microsSinceUnixEpoch / 1000n));
const toEnvelope = (m: MessageRow): Envelope => ({
  id: m.id, group: m.group, topic: m.topic, sentAt: toDate(m.sentAt),
  sender: m.sender, digest: m.digest, payload: Uint8Array.from(m.payload),
});

/** Opens a connection; rejects with the server's reason (bad issuer, expired token, ...). */
function open(opts: ConnectOptions, token: string, onLost: () => void): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    let connected = false;
    DbConnection.builder()
      .withUri(opts.uri)
      .withDatabaseName(opts.db)
      .withToken(token)
      .withCompression('none')
      .withWSFn(directTokenSocket)
      .onConnect(conn => { connected = true; resolve(conn); })
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect((_ctx, err) => (connected ? onLost() : reject(err ?? new Error('disconnected'))))
      .build();
  });
}

export class Client {
  #opts: ConnectOptions;
  #timer?: ReturnType<typeof setTimeout>;
  #watches = new Set<Watch>();
  #intentional = false;
  #settle!: (r: 'expired' | 'closed') => void;
  /** Resolves when the client stops for good: token expired without refresh, or close()/connection lost. */
  readonly closed = new Promise<'expired' | 'closed'>(r => (this.#settle = r));

  private constructor(public conn: DbConnection, opts: ConnectOptions, token: string) {
    this.#opts = opts;
    this.#armExpiry(token);
  }

  static async connect(opts: ConnectOptions): Promise<Client> {
    let lost = () => {};
    const conn = await open(opts, opts.token, () => lost());
    const client = new Client(conn, opts, opts.token);
    lost = () => client.#lost();
    return client;
  }

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
    return this.conn.reducers.send({ address: addr, payload });
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

  /** Messages you're allowed to read, oldest first. Empty if the topic doesn't exist or you lack the read policy. */
  // ponytail: paging is client-side over the subscribed set; add server-side paging if topics get large.
  async pull(addr: string, opts: { afterId?: bigint; limit?: number } = {}): Promise<Envelope[]> {
    const id = await this.#topicId(addr);
    if (id === undefined) return [];
    const rows = await this.#snapshot(`SELECT * FROM my_messages WHERE topic_id = ${id}`,
      () => [...this.conn.db.myMessages.iter()].filter(m => m.topicId === id));
    return rows
      .filter(m => opts.afterId === undefined || m.id > opts.afterId)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, opts.limit)
      .map(toEnvelope);
  }

  /** Existing messages first, then each new one. Survives token refresh. Returns an unsubscribe function. */
  watch(addr: string, onMessage: (e: Envelope) => void): () => void {
    const w: Watch = { addr, onMessage, seen: new Set() };
    this.#watches.add(w);
    void this.#subscribeWatch(w);
    return () => { this.#watches.delete(w); w.stop?.(); };
  }

  close() {
    this.#intentional = true;
    clearTimeout(this.#timer);
    this.conn.disconnect();
    this.#settle('closed');
  }

  async #subscribeWatch(w: Watch) {
    const id = await this.#topicId(w.addr);
    if (id === undefined || !this.#watches.has(w)) return;
    const conn = this.conn;
    const onInsert = (_ctx: unknown, m: MessageRow) => {
      if (m.topicId !== id || w.seen.has(m.id)) return;
      w.seen.add(m.id);
      w.onMessage(toEnvelope(m));
    };
    conn.db.myMessages.onInsert(onInsert);
    const handle = conn.subscriptionBuilder().subscribe(`SELECT * FROM my_messages WHERE topic_id = ${id}`);
    w.stop = () => { conn.db.myMessages.removeOnInsert(onInsert); if (handle.isActive()) handle.unsubscribe(); };
  }

  async #topicId(addr: string): Promise<bigint | undefined> {
    return this.#snapshot(`SELECT * FROM topic WHERE address = ${sqlString(addr)}`,
      () => [...this.conn.db.topic.iter()].find(t => t.address === addr)?.id);
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

  #armExpiry(token: string) {
    const ms = decodeExp(token) * 1000 - Date.now();
    this.#timer = setTimeout(() => void this.#expire(), Math.max(0, Math.min(ms, 2 ** 31 - 1)));
  }

  async #expire() {
    this.#intentional = true;
    for (const w of this.#watches) w.stop?.();
    this.conn.disconnect();
    const token = await this.#opts.onExpired?.().catch(() => undefined);
    if (!token) return this.#settle('expired');
    try {
      this.conn = await open(this.#opts, token, () => this.#lost());
    } catch {
      return this.#settle('expired');
    }
    this.#intentional = false;
    this.#armExpiry(token);
    for (const w of this.#watches) void this.#subscribeWatch(w);
  }

  #lost() {
    if (this.#intentional) return;
    clearTimeout(this.#timer);
    this.#settle('closed');
  }
}

export const connect = (opts: ConnectOptions) => Client.connect(opts);
