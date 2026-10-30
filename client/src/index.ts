import { DbConnection } from './bindings';
import { decodeExp } from './jwt';
import { directTokenSocket } from './ws';

export { decodeClaims, decodeExp } from './jwt';
export * from './oauth';
export { displayText, parseLifetime, topicAccess } from './access';
export { setGlobalLogLevel as setLogLevel } from 'spacetimedb';

export type ConnectOptions = {
  uri: string;
  db: string;
  /** Omit to connect anonymously; only accepted while the server has auth disabled (dev). */
  token?: string;
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

type Watch = {
  addr: string; onMessage: (e: Envelope) => void; onError?: (err: Error) => void;
  seen: Set<bigint>; stop?: () => void;
};

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const toDate = (ts: { microsSinceUnixEpoch: bigint }) => new Date(Number(ts.microsSinceUnixEpoch / 1000n));
const toEnvelope = (m: MessageRow): Envelope => ({
  id: m.id, group: m.group, topic: m.topic, sentAt: toDate(m.sentAt),
  sender: m.sender, digest: m.digest, payload: Uint8Array.from(m.payload),
});

/** Opens a connection; rejects with the server's reason (bad issuer, expired token, ...). */
function open(opts: ConnectOptions, token: string | undefined, onLost: () => void): Promise<DbConnection> {
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
  #closedByUser = false;
  /** Why calls can't run right now (between connections, or for good), else undefined. */
  #dead?: string;
  #kill!: (e: Error) => void;
  /** Rejects when the current connection goes away; raced against every call so none hang. */
  #gone!: Promise<never>;
  #settle!: (r: 'expired' | 'closed') => void;
  /** Resolves when the client stops for good: token expired without refresh, or close()/connection lost. */
  readonly closed = new Promise<'expired' | 'closed'>(r => (this.#settle = r));

  private constructor(public conn: DbConnection, opts: ConnectOptions, token: string | undefined) {
    this.#opts = opts;
    this.#resetGone();
    if (token) this.#armExpiry(token);
  }

  static async connect(opts: ConnectOptions): Promise<Client> {
    let lost = () => {};
    const conn = await open(opts, opts.token, () => lost());
    const client = new Client(conn, opts, opts.token);
    lost = () => client.#lost();
    return client;
  }

  createGroup(name: string, opts: { createTopicPolicies: string[] }): Promise<void> {
    return this.#call(() => this.conn.reducers.createGroup({ name, createTopicPolicies: opts.createTopicPolicies }));
  }

  createTopic(
    addr: string,
    opts: { readPolicies: string[]; writePolicies: string[]; lifetimeSecs?: number }
  ): Promise<void> {
    return this.#call(() => this.conn.reducers.createTopic({
      address: addr,
      readPolicies: opts.readPolicies,
      writePolicies: opts.writePolicies,
      lifetimeSecs: opts.lifetimeSecs === undefined ? undefined : BigInt(opts.lifetimeSecs),
    }));
  }

  send(addr: string, payload: Uint8Array): Promise<void> {
    return this.#call(() => this.conn.reducers.send({ address: addr, payload }));
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

  /** True when the server has every auth check turned off (dev mode). */
  async authDisabled(): Promise<boolean> {
    return this.#snapshot('SELECT * FROM auth_mode', () => !!this.conn.db.authMode.id.find(0)?.disabled);
  }

  /** Messages you're allowed to read, oldest first. Rejects if the topic doesn't exist; empty if you lack the read policy. */
  // ponytail: paging is client-side over the subscribed set; add server-side paging if topics get large.
  async pull(addr: string, opts: { afterId?: bigint; limit?: number } = {}): Promise<Envelope[]> {
    const id = await this.#requireTopicId(addr);
    const rows = await this.#snapshot(`SELECT * FROM my_messages WHERE topic_id = ${id}`,
      () => [...this.conn.db.myMessages.iter()].filter(m => m.topicId === id));
    return rows
      .filter(m => opts.afterId === undefined || m.id > opts.afterId)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, opts.limit)
      .map(toEnvelope);
  }

  /**
   * Existing messages first, then each new one. Survives token refresh. Returns an unsubscribe function.
   * onError: unknown topic or failed subscription (the watch stops).
   */
  watch(addr: string, onMessage: (e: Envelope) => void, onError?: (err: Error) => void): () => void {
    const w: Watch = { addr, onMessage, onError, seen: new Set() };
    this.#watches.add(w);
    void this.#subscribeWatch(w);
    return () => { this.#watches.delete(w); w.stop?.(); };
  }

  close() {
    this.#closedByUser = true;
    this.#intentional = true;
    clearTimeout(this.#timer);
    this.#fail('connection closed');
    this.conn.disconnect();
    this.#settle('closed');
  }

  #resetGone() {
    this.#dead = undefined;
    this.#gone = new Promise<never>((_, reject) => (this.#kill = reject));
    this.#gone.catch(() => {});
  }

  #fail(reason: string) {
    this.#dead = reason;
    this.#kill(new Error(reason));
  }

  /** Runs fn on the live connection; rejects (never hangs) if that connection goes away first. */
  #call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#dead) return Promise.reject(new Error(this.#dead));
    return Promise.race([fn(), this.#gone]);
  }

  async #subscribeWatch(w: Watch) {
    const fail = (e: unknown) => {
      if (!this.#watches.delete(w)) return;
      w.stop?.();
      w.onError?.(e instanceof Error ? e : new Error(String(e)));
    };
    let id: bigint;
    try { id = await this.#requireTopicId(w.addr); } catch (e) { return fail(e); }
    if (!this.#watches.has(w)) return;
    const conn = this.conn;
    const onInsert = (_ctx: unknown, m: MessageRow) => {
      if (m.topicId !== id || w.seen.has(m.id)) return;
      w.seen.add(m.id);
      w.onMessage(toEnvelope(m));
    };
    conn.db.myMessages.onInsert(onInsert);
    const handle = conn.subscriptionBuilder()
      .onError(ctx => fail(ctx.event ?? new Error('subscription failed')))
      .subscribe(`SELECT * FROM my_messages WHERE topic_id = ${id}`);
    w.stop = () => { conn.db.myMessages.removeOnInsert(onInsert); if (handle.isActive()) handle.unsubscribe(); };
  }

  async #requireTopicId(addr: string): Promise<bigint> {
    const id = await this.#snapshot(`SELECT * FROM topic WHERE address = ${sqlString(addr)}`,
      () => [...this.conn.db.topic.iter()].find(t => t.address === addr)?.id);
    if (id === undefined) throw new Error(`no such topic ${addr}`);
    return id;
  }

  /** Subscribe, read the applied rows, unsubscribe. */
  #snapshot<T>(sql: string, read: () => T): Promise<T> {
    return this.#call(() => new Promise((resolve, reject) => {
      const handle = this.conn.subscriptionBuilder()
        .onApplied(() => { const rows = read(); handle.unsubscribe(); resolve(rows); })
        .onError(ctx => reject(ctx.event ?? new Error('subscription failed')))
        .subscribe(sql);
    }));
  }

  #armExpiry(token: string) {
    const ms = decodeExp(token) * 1000 - Date.now();
    this.#timer = setTimeout(() => void this.#expire(), Math.max(0, Math.min(ms, 2 ** 31 - 1)));
  }

  async #expire() {
    this.#intentional = true;
    this.#fail('token expired');
    for (const w of this.#watches) w.stop?.();
    this.conn.disconnect();
    const token = await this.#opts.onExpired?.().catch(() => undefined);
    if (this.#closedByUser) return;
    if (!token) return this.#settle('expired');
    let conn: DbConnection;
    try {
      conn = await open(this.#opts, token, () => this.#lost());
    } catch {
      return this.#settle('expired');
    }
    if (this.#closedByUser) return conn.disconnect(); // close() was called while we were refreshing
    this.conn = conn;
    this.#resetGone();
    this.#intentional = false;
    this.#armExpiry(token);
    for (const w of this.#watches) void this.#subscribeWatch(w);
  }

  #lost() {
    if (this.#intentional) return;
    clearTimeout(this.#timer);
    this.#fail('connection closed');
    this.#settle('closed');
  }
}

export const connect = (opts: ConnectOptions) => Client.connect(opts);
