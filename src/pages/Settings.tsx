import { useEffect, useState } from 'react';
import { AppNav } from '../components/AppNav';
import { api, when } from '../lib/api';

interface KeyInfo {
  provider: string;
  last4: string;
  updatedAt: number;
}
interface ModeInfo {
  mode: string;
  label: string;
  cost: number;
  provider: string | null;
  available: boolean;
}

const PROVIDERS = [
  { id: 'replicate', label: 'Replicate', hint: 'Used for image-to-video in “Bring your own key” mode.' },
  { id: 'openai', label: 'OpenAI', hint: 'Stored and testable. Not used by a generation mode yet.' },
];

export function Settings() {
  const [keys, setKeys] = useState<KeyInfo[] | null>(null);
  const [modes, setModes] = useState<ModeInfo[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setKeys((await api<{ keys: KeyInfo[] }>('GET', '/api/keys')).keys);
      setModes((await api<{ modes: ModeInfo[] }>('GET', '/api/modes')).modes);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settings.');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const say = (provider: string, text: string) => setMessage((m) => ({ ...m, [provider]: text }));

  const save = async (provider: string) => {
    try {
      await api('PUT', `/api/keys/${provider}`, { apiKey: drafts[provider] });
      setDrafts((d) => ({ ...d, [provider]: '' }));
      say(provider, 'Key saved. It is encrypted and cannot be shown again.');
      await load();
    } catch (e) {
      say(provider, e instanceof Error ? e.message : 'Could not save the key.');
    }
  };
  const test = async (provider: string) => {
    say(provider, 'Testing…');
    try {
      say(provider, (await api<{ message: string }>('POST', `/api/keys/${provider}/test`, {})).message);
    } catch (e) {
      say(provider, e instanceof Error ? e.message : 'Could not test the key.');
    }
  };
  const remove = async (provider: string) => {
    if (!window.confirm('Remove this key?')) return;
    try {
      await api('DELETE', `/api/keys/${provider}`);
      say(provider, 'Key removed.');
      await load();
    } catch (e) {
      say(provider, e instanceof Error ? e.message : 'Could not remove the key.');
    }
  };

  return (
    <div className="landing">
      <AppNav current="settings" />
      <h1>AI providers</h1>
      <p className="muted">Bring your own key to pay a provider directly. Keys are encrypted on the server, used only for your own generations, never shown again and never included in exports.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!keys && !error && <p className="muted">Loading…</p>}

      {keys && (
        <ul className="cards">
          {PROVIDERS.map((p) => {
            const saved = keys.find((k) => k.provider === p.id);
            return (
              <li key={p.id}>
                <b>{p.label}</b>
                <span>{p.hint}</span>
                <span>{saved ? `Saved key ending in ${saved.last4} · updated ${when(saved.updatedAt)}` : 'No key saved.'}</span>
                <label className="field"><span>{saved ? 'Replace key' : 'API key'}</span>
                  <input type="password" autoComplete="off" spellCheck={false} value={drafts[p.id] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))} />
                </label>
                <div className="row">
                  <button type="button" className="btn small primary" disabled={!(drafts[p.id] ?? '').trim()} onClick={() => void save(p.id)}>{saved ? 'Replace' : 'Save'}</button>
                  <button type="button" className="btn small" disabled={!saved} onClick={() => void test(p.id)}>Test</button>
                  <button type="button" className="btn small ghost danger" disabled={!saved} onClick={() => void remove(p.id)}>Remove</button>
                </div>
                <p role="status" className="muted small-note">{message[p.id] ?? ''}</p>
              </li>
            );
          })}
        </ul>
      )}

      <h2>Generation modes</h2>
      <p className="muted">What each mode will use, and what it costs, before you start a generation.</p>
      <table>
        <thead><tr><th scope="col">Mode</th><th scope="col">Provider</th><th scope="col">Credits</th><th scope="col">Status</th></tr></thead>
        <tbody>
          {modes.map((m) => (
            <tr key={m.mode}>
              <th scope="row">{m.label}</th>
              <td>{m.provider ?? '—'}</td>
              <td>{m.cost}</td>
              <td>{m.available ? 'Available' : 'Not set up on this server'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
