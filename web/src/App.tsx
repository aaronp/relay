import { useEffect, useRef, useState } from 'react';
import { connect, decodeClaims, type Client, type TopicInfo, type Tokens } from '@topics/client';
import { ConnectionPane, type Claims } from './ConnectionPane';
import { TopicPane } from './TopicPane';
import { TopicsPane } from './TopicsPane';
import {
  completeLogin, loadSettings, loadTokens, refresh, saveSettings, saveTokens, usableTokens, type Settings,
} from './session';

// StrictMode runs effects twice in dev; the callback (and its one-shot PKCE state) must be handled once.
let callbackHandled = false;

const claimsOf = (t: Tokens | null): Claims | null => {
  try { return t ? decodeClaims(t.token) : null; } catch { return null; }
};

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [tokens, setTokens] = useState<Tokens | null>(loadTokens);
  const [client, setClient] = useState<Client | null>(null);
  const [connection, setConnection] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');
  const [notice, setNotice] = useState<string>();
  // Kept apart from `notice` so a connect that succeeds with the old token can't erase a failed sign-in.
  const [authError, setAuthError] = useState<string>();
  const [session, setSession] = useState(0); // bump to (re)connect
  const [group, setGroup] = useState('');
  const [topics, setTopics] = useState<TopicInfo[]>([]);
  const [selected, setSelected] = useState<TopicInfo>();
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (window.location.pathname !== '/callback' || callbackHandled) return;
    callbackHandled = true;
    completeLogin(window.location.href)
      .then(t => { setAuthError(undefined); setTokens(t); setSession(n => n + 1); })
      .catch(e => setAuthError(`sign-in failed: ${e instanceof Error ? e.message : e}`));
  }, []);

  useEffect(() => {
    const t = tokensRef.current;
    if (!t) return;
    let cancelled = false;
    let c: Client | undefined;
    let refreshError: string | undefined;
    setConnection('connecting');
    const signedOut = (why: string) => {
      saveTokens(null);
      setTokens(null);
      setNotice(`signed out — ${why}`);
    };
    usableTokens(settingsRef.current, t).then(tok => {
      if (cancelled) return;
      if (tok !== t) setTokens(tok);
      return connect({
        uri: settings.server,
        db: settings.db,
        token: tok.token,
        onExpired: async () => {
          const r = await refresh(settingsRef.current, tokensRef.current);
          if ('error' in r) { refreshError = r.error; return undefined; }
          setTokens(r.tokens);
          return r.tokens.token;
        },
      }).then(onConnected);
    }, e => {
      if (cancelled) return;
      setConnection('disconnected');
      signedOut(e instanceof Error ? e.message : String(e));
    }).catch(e => {
      if (cancelled) return;
      setConnection('disconnected');
      setNotice(`connect failed: ${e instanceof Error ? e.message : e}`);
    });
    function onConnected(conn: Client) {
      if (cancelled) return conn.close();
      c = conn;
      setClient(conn);
      setConnection('connected');
      setNotice(undefined);
      conn.closed.then(why => {
        if (cancelled) return;
        setClient(null);
        setConnection('disconnected');
        if (why === 'expired') {
          signedOut(`token expired${refreshError ? ` (refresh failed: ${refreshError})` : ''}`);
        } else {
          setNotice('connection closed — click Reconnect');
        }
      });
    }
    return () => { cancelled = true; c?.close(); setClient(null); };
    // settings changes apply on Reconnect, not on every keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <main className="app">
      <ConnectionPane
        settings={settings}
        onSettings={s => { setSettings(s); saveSettings(s); }}
        claims={claimsOf(tokens)}
        connection={connection}
        notice={[authError, notice].filter(Boolean).join('\n') || undefined}
        onReconnect={() => { setAuthError(undefined); setSession(n => n + 1); }}
        onSignOut={() => {
          saveTokens(null); setTokens(null); setSession(n => n + 1); setNotice(undefined); setAuthError(undefined);
        }}
      />
      <TopicsPane
        client={client}
        claims={claimsOf(tokens)}
        group={group}
        onGroup={setGroup}
        topics={topics}
        onTopics={setTopics}
        selected={selected?.address}
        onSelect={setSelected}
      />
      {/* key: per-topic state (messages, late Pull results, statuses) never leaks into another topic */}
      <TopicPane key={selected?.address} client={client} topic={selected} />
    </main>
  );
}
