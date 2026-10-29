import { DbConnection } from './bindings';
import { directTokenSocket } from './ws';

export { decodeExp } from './jwt';

export type ConnectOptions = { uri: string; db: string; token: string };

export class Client {
  constructor(readonly conn: DbConnection) {}

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
