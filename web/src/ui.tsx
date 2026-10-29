import { useState } from 'react';

/** Busy/error/ok state for one button. Errors are shown verbatim. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();
  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setError(undefined);
    setOk(undefined);
    try {
      const msg = await fn();
      if (msg) setOk(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error, ok, setError };
}

export function Status({ a }: { a: { error?: string; ok?: string } }) {
  if (a.error) return <div className="error">{a.error}</div>;
  if (a.ok) return <div className="ok">{a.ok}</div>;
  return null;
}

export function Field(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input value={props.value} placeholder={props.placeholder} onChange={e => props.onChange(e.target.value)} />
    </label>
  );
}
