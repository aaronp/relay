import { useState } from 'react';
import { parseLifetime, topicAccess, type Client, type TopicInfo } from '@topics/client';
import type { Claims } from './ConnectionPane';
import { parseSaids } from './format';
import { Field, Status, useAction } from './ui';

type Props = {
  client: Client | null;
  claims: Claims | null;
  authOff: boolean;
  group: string;
  onGroup: (g: string) => void;
  topics: TopicInfo[];
  onTopics: (t: TopicInfo[]) => void;
  selected?: string;
  onSelect: (t: TopicInfo) => void;
};

export function TopicsPane({ client, claims, authOff, group, onGroup, topics, onTopics, selected, onSelect }: Props) {
  const [createTopicSaids, setCreateTopicSaids] = useState('');
  const [topicName, setTopicName] = useState('');
  const [readSaids, setReadSaids] = useState('');
  const [writeSaids, setWriteSaids] = useState('');
  const [lifetime, setLifetime] = useState('');
  const createGroup = useAction();
  const load = useAction();
  const createTopic = useAction();

  const need = () => {
    if (!client) throw new Error('not connected');
    return client;
  };
  const reload = async () => onTopics(await need().listTopics(group.trim()));

  return (
    <section className="pane">
      <h2>Groups &amp; topics</h2>
      <Field label="Group" value={group} onChange={onGroup} placeholder="example" />

      <fieldset>
        <legend>Create group</legend>
        <Field label="create-topic policy SAIDs" value={createTopicSaids} onChange={setCreateTopicSaids}
          placeholder="SAID1, SAID2" />
        <button disabled={createGroup.busy} onClick={() => createGroup.run(async () => {
          await need().createGroup(group.trim(), { createTopicPolicies: parseSaids(createTopicSaids) });
          return `created group ${group.trim()}`;
        })}>Create group</button>
        <Status a={createGroup} />
      </fieldset>

      <div className="row">
        <button disabled={load.busy} onClick={() => load.run(reload)}>Load topics</button>
      </div>
      <Status a={load} />

      <ul className="topics">
        {topics.map(t => {
          const access = authOff ? { read: true, write: true } : claims ? topicAccess(claims, t) : { read: false, write: false };
          return (
            <li key={t.address} className={t.address === selected ? 'selected' : ''} onClick={() => onSelect(t)}>
              <strong>{t.name}</strong>
              <span className={`badge ${access.read ? 'yes' : 'no'}`}>{access.read ? 'can read' : 'no read'}</span>
              <span className={`badge ${access.write ? 'yes' : 'no'}`}>{access.write ? 'can write' : 'no write'}</span>
              <div className="meta">
                read: {t.readPolicies.join(', ') || '(owner only)'} · write: {t.writePolicies.join(', ') || '(owner only)'}
                {' · '}owner: {t.owner}
                {t.expiresAt && ` · expires ${t.expiresAt.toLocaleString()}`}
              </div>
            </li>
          );
        })}
        {!topics.length && <li className="muted">no topics loaded</li>}
      </ul>

      <fieldset>
        <legend>Create topic in “{group || '…'}”</legend>
        <Field label="Topic name" value={topicName} onChange={setTopicName} placeholder="foo" />
        <Field label="read policy SAIDs" value={readSaids} onChange={setReadSaids} placeholder="SAID1, SAID2" />
        <Field label="write policy SAIDs" value={writeSaids} onChange={setWriteSaids} placeholder="SAID1" />
        <Field label="lifetime (optional)" value={lifetime} onChange={setLifetime} placeholder="30s · 15m · 12h · 7d" />
        <button disabled={createTopic.busy} onClick={() => createTopic.run(async () => {
          const addr = `${group.trim()}.${topicName.trim()}`;
          await need().createTopic(addr, {
            readPolicies: parseSaids(readSaids),
            writePolicies: parseSaids(writeSaids),
            lifetimeSecs: lifetime.trim() ? parseLifetime(lifetime.trim()) : undefined,
          });
          await reload();
          return `created topic ${addr}`;
        })}>Create topic</button>
        <Status a={createTopic} />
      </fieldset>
    </section>
  );
}
