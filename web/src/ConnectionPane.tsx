import { useEffect, useState } from 'react';
import { beginLogin, type Settings } from './session';
import { Field, Status, useAction } from './ui';

export type Claims = { sub: string; saids: string[]; exp: number };

type Props = {
  settings: Settings;
  onSettings: (s: Settings) => void;
  claims: Claims | null;
  connection: 'connected' | 'connecting' | 'disconnected';
  anonymous: boolean;
  /** Server reports every auth check turned off. */
  authOff: boolean;
  onAnonymous: () => void;
  notice?: string;
  onReconnect: () => void;
  onSignOut: () => void;
};

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function remaining(exp: number, now: number) {
  const s = Math.floor(exp - now / 1000);
  if (s <= 0) return 'expired';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

export function ConnectionPane({
  settings, onSettings, claims, connection, anonymous, authOff, onAnonymous, notice, onReconnect, onSignOut,
}: Props) {
  const login = useAction();
  const now = useNow();
  const set = (k: keyof Settings) => (v: string) => onSettings({ ...settings, [k]: v });

  return (
    <section className="pane">
      <h2>Connection</h2>
      {authOff && <div className="banner">AUTH DISABLED on this database — anyone can create, send and read</div>}
      <Field label="Wallet server" value={settings.walletUrl} onChange={set('walletUrl')} />
      <Field label="SpacetimeDB" value={settings.server} onChange={set('server')} />
      <Field label="Database" value={settings.db} onChange={set('db')} />
      <div className="row">
        <button disabled={login.busy} onClick={() => login.run(() => beginLogin(settings))}>
          {claims ? 'Re-authenticate' : 'Authenticate with kerits'}
        </button>
        {!claims && !anonymous && <button onClick={onAnonymous}>Connect without auth</button>}
        {(claims || anonymous) && <button onClick={onReconnect}>Reconnect</button>}
        {(claims || anonymous) && <button onClick={onSignOut}>Sign out</button>}
      </div>
      <Status a={login} />
      {notice && <div className="error">{notice}</div>}

      <h3>Token</h3>
      {anonymous ? (
        <dl className="claims">
          <dt>token</dt><dd><em>none (anonymous)</em></dd>
          <dt>connection</dt><dd className={connection}>{connection}</dd>
        </dl>
      ) : claims ? (
        <dl className="claims">
          <dt>sub</dt><dd><code>{claims.sub}</code></dd>
          <dt>policy SAIDs</dt>
          <dd>{claims.saids.length ? claims.saids.map(s => <code key={s} className="said">{s}</code>) : <em>none</em>}</dd>
          <dt>expires</dt>
          <dd>{new Date(claims.exp * 1000).toLocaleTimeString()} ({remaining(claims.exp, now)})</dd>
          <dt>connection</dt><dd className={connection}>{connection}</dd>
        </dl>
      ) : (
        <p className="muted">signed out</p>
      )}
    </section>
  );
}
