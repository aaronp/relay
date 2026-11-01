import { DbConnection } from './bindings';
import { decodeExp } from './jwt';
import { directTokenSocket } from './ws';
import { topicAccess } from './access';

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
  deletePolicies: string[];
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

/** Where to start: the beginning (default), new messages only ('now'), or after a message id you saved. */
export type WatchOptions = { from?: 'now' | bigint };

/** A changeable set of topics delivered through one callback, on the client's one connection. */
export type TopicStream = {
  /** Adding a topic already in the set does nothing. */
  add(addr: string, opts?: WatchOptions): void;
  remove(addr: string): void;
  /** The topics currently in the set. */
  readonly topics: string[];
  close(): void;
};

type Watch = {
  addr: string; onMessage: (e: Envelope) => void; onError?: (err: Error) => void;
  /** Highest message id handled; anything at or below it is skipped. */
  cursor: bigint;
  /** from: 'now' until the first subscription applies; a later resubscribe must not skip what it missed. */
  skipHistory: boolean;
  stop?: () => void;
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
    opts: { readPolicies: string[]; writePolicies: string[]; deletePolicies?: string[]; lifetimeSecs?: number }
  ): Promise<void> {
    return this.#call(() => this.conn.reducers.createTopic({
      address: addr,
      readPolicies: opts.readPolicies,
      writePolicies: opts.writePolicies,
      lifetimeSecs: opts.lifetimeSecs === undefined ? undefined : BigInt(opts.lifetimeSecs),
      deletePolicies: opts.deletePolicies ?? [],
    }));
  }

  /** Removes the topic and its messages. Needs one of its deletePolicies, or to be its owner. */
  deleteTopic(addr: string): Promise<void> {
    return this.#call(() => this.conn.reducers.deleteTopic({ address: addr }));
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
      deletePolicies: t.deletePolicies,
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
   * Existing messages in id order (see opts.from), then each new one. Survives token refresh without gaps or
   * repeats. Returns an unsubscribe function.
   * onError: unknown or unreadable topic, topic deleted or expired, or failed subscription (the watch stops).
   */
  watch(
    addr: string,
    onMessage: (e: Envelope) => void,
    onError?: (err: Error) => void,
    opts: WatchOptions = {}
  ): () => void {
    const w: Watch = {
      addr, onMessage, onError,
      cursor: typeof opts.from === 'bigint' ? opts.from : 0n, // ids start at 1
      skipHistory: opts.from === 'now',
    };
    this.#watches.add(w);
    void this.#subscribeWatch(w);
    return () => { this.#watches.delete(w); w.stop?.(); };
  }

  /** Follow a set of topics you can change at any time. Envelopes carry their group and topic. */
  stream(onMessage: (e: Envelope) => void, onError?: (err: Error, addr: string) => void): TopicStream {
    const stops = new Map<string, () => void>();
    const remove = (addr: string) => { stops.get(addr)?.(); stops.delete(addr); };
    return {
      add: (addr, opts) => {
        if (stops.has(addr)) return;
        stops.set(addr, this.watch(addr, onMessage, err => { stops.delete(addr); onError?.(err, addr); }, opts));
      },
      remove,
      get topics() { return [...stops.keys()]; },
      close: () => { for (const addr of [...stops.keys()]) remove(addr); },
    };
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
    try { id = await this.#readableTopicId(w.addr); } catch (e) { return fail(e); }
    if (!this.#watches.has(w)) return;
    const conn = this.conn;
    let live = false;
    let stopped = false;
    const removed = () => fail(new Error(`topic ${w.addr} was removed`));
    const deliver = (m: MessageRow) => {
      if (stopped || m.id <= w.cursor) return;
      w.cursor = m.id;
      w.onMessage(toEnvelope(m));
    };
    const onInsert = (_ctx: unknown, m: MessageRow) => { if (live && m.topicId === id) deliver(m); };
    // Before `live`, a delete can just be the access check's own subscription letting go of this row.
    const onTopicDelete = (_ctx: unknown, t: { id: bigint }) => { if (live && t.id === id) removed(); };
    conn.db.myMessages.onInsert(onInsert);
    conn.db.topic.onDelete(onTopicDelete);
    const after = w.cursor > 0n ? ` AND id > ${w.cursor}` : '';
    const handle = conn.subscriptionBuilder()
      .onApplied(() => {
        if (stopped) return handle.unsubscribe();
        if (!conn.db.topic.id.find(id)) return removed(); // deleted after the access check
        // ponytail: from 'now' downloads the topic's history to find its end; add a server-side tail if topics get large.
        // Read the cache, not inserts: rows another subscription already holds fire no insert.
        const rows = [...conn.db.myMessages.iter()].filter(m => m.topicId === id).sort((a, b) => (a.id < b.id ? -1 : 1));
        if (w.skipHistory) w.cursor = rows.at(-1)?.id ?? w.cursor;
        else rows.forEach(deliver);
        w.skipHistory = false;
        live = true;
      })
      .onError(ctx => fail(ctx.event ?? new Error('subscription failed')))
      .subscribe([`SELECT * FROM my_messages WHERE topic_id = ${id}${after}`, `SELECT * FROM topic WHERE id = ${id}`]);
    w.stop = () => {
      stopped = true;
      conn.db.myMessages.removeOnInsert(onInsert);
      conn.db.topic.removeOnDelete(onTopicDelete);
      if (handle.isActive()) handle.unsubscribe();
    };
  }

  /** The topic's id, or throws if it doesn't exist or you can't read it. The server enforces this regardless. */
  async #readableTopicId(addr: string): Promise<bigint> {
    const { topic, session, authOff } = await this.#snapshot(
      [`SELECT * FROM topic WHERE address = ${sqlString(addr)}`, 'SELECT * FROM my_session', 'SELECT * FROM auth_mode'],
      () => ({
        topic: [...this.conn.db.topic.iter()].find(t => t.address === addr),
        session: [...this.conn.db.mySession.iter()][0],
        authOff: !!this.conn.db.authMode.id.find(0)?.disabled,
      })
    );
    if (!topic) throw new Error(`no such topic ${addr}`);
    const canRead = authOff || (session && topicAccess({ sub: session.subject, saids: session.policySaids }, topic).read);
    if (!canRead) throw new Error(`no read access to ${addr}`);
    return topic.id;
  }

  async #requireTopicId(addr: string): Promise<bigint> {
    const id = await this.#snapshot(`SELECT * FROM topic WHERE address = ${sqlString(addr)}`,
      () => [...this.conn.db.topic.iter()].find(t => t.address === addr)?.id);
    if (id === undefined) throw new Error(`no such topic ${addr}`);
    return id;
  }

  /** Subscribe, read the applied rows, unsubscribe. */
  #snapshot<T>(sql: string | string[], read: () => T): Promise<T> {
    return this.#call(() => new Promise((resolve, reject) => {
      const handle = this.conn.subscriptionBuilder()
        .onApplied(() => { const rows = read(); handle.unsubscribe(); resolve(rows); })
        .onError(ctx => reject(ctx.event ?? new Error('subscription failed')))
        .subscribe([sql].flat());
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
