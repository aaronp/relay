import { useEffect, useState } from 'react';
import type { Client, Envelope, TopicInfo } from '@aaronp/relay-client';
import { displayPayload } from './format';
import { Status, useAction } from './ui';

type Props = { client: Client | null; topic?: TopicInfo };

export function TopicPane({ client, topic }: Props) {
  const [messages, setMessages] = useState<Envelope[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string>();
  const [text, setText] = useState('');
  const pull = useAction();
  const send = useAction();

  // Turn the stream off when the connection changes (a topic change remounts this pane).
  useEffect(() => {
    setStreaming(false);
    setStreamError(undefined);
  }, [client]);

  useEffect(() => {
    if (!streaming || !client || !topic) return;
    const seen = new Set<bigint>();
    return client.watch(
      topic.address,
      e => {
        if (seen.has(e.id)) return;
        seen.add(e.id);
        setMessages(m => (m.some(x => x.id === e.id) ? m : [...m, e].sort((a, b) => (a.id < b.id ? -1 : 1))));
      },
      err => { setStreamError(err.message); setStreaming(false); }
    );
  }, [streaming, client, topic?.address]);

  if (!topic) return <section className="pane"><h2>Topic</h2><p className="muted">select a topic</p></section>;

  const need = () => {
    if (!client) throw new Error('not connected');
    return client;
  };

  return (
    <section className="pane">
      <h2><code>{topic.address}</code> {streaming && <span className="live">● streaming</span>}</h2>
      <div className="row">
        <button disabled={pull.busy} onClick={() => pull.run(async () => {
          const msgs = await need().pull(topic.address);
          setMessages(msgs);
          return `${msgs.length} message(s)`;
        })}>Pull</button>
        <label className="toggle">
          <input type="checkbox" checked={streaming} disabled={!client}
            onChange={e => { setStreamError(undefined); setStreaming(e.target.checked); }} />
          Stream
        </label>
      </div>
      <Status a={pull} />
      {streamError && <div className="error">{streamError}</div>}

      <ol className="messages">
        {messages.map(m => (
          <li key={String(m.id)}>
            <span className="time">{m.sentAt.toLocaleTimeString()}</span>
            <span className="sender">{m.sender}</span>
            <span className="text">{displayPayload(m.payload)}</span>
            <div className="meta">#{String(m.id)} · digest {m.digest.slice(0, 12)}… · {m.payload.length} bytes</div>
          </li>
        ))}
        {!messages.length && <li className="muted">no messages shown</li>}
      </ol>

      <form className="row" onSubmit={e => {
        e.preventDefault();
        send.run(async () => {
          await need().send(topic.address, new TextEncoder().encode(text));
          setText('');
        });
      }}>
        <input className="grow" value={text} onChange={e => setText(e.target.value)} placeholder="message…" />
        <button disabled={send.busy} type="submit">Send</button>
      </form>
      <Status a={send} />
    </section>
  );
}
