import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { AppNav } from '../components/AppNav';
import { api, uploadBinary } from '../lib/api';
import { useSession } from '../lib/session';
import { emptyScene, newObject } from '../scene/defaults';
import { DESIGN_TYPES, LOGO_ANIMATIONS, buildDesignPrompt, logoAnimationPlan, typeInfo } from '../studio/briefs';
import type { Brief, DesignType } from '../studio/briefs';

/** Every design lives in one project, so it shows up in the editor and on the dashboard too. */
export const STUDIO_PROJECT = 'Brand Studio';

interface DesignTool {
  kind: 'design';
  cost: number;
  provider: string | null;
  keyProvider: string | null;
  available: boolean;
  platformKey: boolean;
}

interface Design {
  id: string;
  name: string;
}

interface Pending {
  jobId: string;
  label: string;
  error?: string;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY_NAMES: Record<string, string> = { replicate: 'Replicate', openai: 'OpenAI' };
const keyName = (k: string | null) => (k ? KEY_NAMES[k] ?? k : 'API');

export function Studio() {
  const session = useSession();
  const [tool, setTool] = useState<DesignTool | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [brief, setBrief] = useState<Brief>({ type: 'logo', styleId: DESIGN_TYPES[0].styles[0].id, name: '', tagline: '', about: '', details: '', colors: '', notes: '', transparent: true });
  const [count, setCount] = useState(2);
  const [useOwnKey, setUseOwnKey] = useState(false);
  const [customPrompt, setCustomPrompt] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [animateFor, setAnimateFor] = useState<Design | null>(null);
  const [animation, setAnimation] = useState(LOGO_ANIMATIONS[0].id);
  const [animating, setAnimating] = useState(false);

  const info = typeInfo(brief.type);
  const built = useMemo(() => buildDesignPrompt(brief), [brief]);
  const prompt = customPrompt ?? built.prompt;
  const ownKeyOnly = Boolean(tool && !tool.platformKey);
  const payWithKey = ownKeyOnly || useOwnKey;
  const total = payWithKey ? 0 : (tool?.cost ?? 0) * count;

  const loadDesigns = async (pid: string) => {
    const { assets } = await api<{ assets: Design[] }>('GET', `/api/projects/${pid}/assets`);
    setDesigns(assets.filter((a) => a.id.startsWith('design-')).reverse());
  };

  useEffect(() => {
    (async () => {
      try {
        const [modes, list] = await Promise.all([
          api<{ tools: (DesignTool | { kind: string })[]; balance: number }>('GET', '/api/modes'),
          api<{ projects: { id: string; name: string; teamId: string | null }[] }>('GET', '/api/projects'),
        ]);
        setTool((modes.tools.find((t) => t.kind === 'design') as DesignTool | undefined) ?? null);
        session.setCredits(modes.balance);
        const studio = list.projects.find((p) => p.name === STUDIO_PROJECT && !p.teamId);
        if (studio) {
          setProjectId(studio.id);
          await loadDesigns(studio.id);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load Brand Studio.');
      } finally {
        setLoading(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<Brief>) => {
    setBrief((b) => ({ ...b, ...patch }));
    setCustomPrompt(null);
  };
  const chooseType = (type: DesignType) => set({ type, styleId: typeInfo(type).styles[0].id });

  const ensureProject = async (): Promise<string> => {
    if (projectId) return projectId;
    const r = await api<{ project: { id: string } }>('POST', '/api/projects', { name: STUDIO_PROJECT });
    setProjectId(r.project.id);
    return r.project.id;
  };

  const waitFor = async (pid: string, jobId: string) => {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await pause(2500);
      const { job } = await api<{ job: { status: string; error: string | null } }>('GET', `/api/jobs/${jobId}`);
      if (job.status === 'complete') {
        setPending((p) => p.filter((x) => x.jobId !== jobId));
        await loadDesigns(pid);
        return;
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        setPending((p) => p.map((x) => (x.jobId === jobId ? { ...x, error: job.error ?? 'The design could not be made.' } : x)));
        return;
      }
    }
    setPending((p) => p.map((x) => (x.jobId === jobId ? { ...x, error: 'This is taking longer than expected. Check back shortly.' } : x)));
  };

  const generate = async (e: FormEvent) => {
    e.preventDefault();
    if (!tool || busy) return;
    setError('');
    const priced = total ? `${total} credits` : 'your own API key (no credits)';
    if (!window.confirm(`Create ${count} ${info.label.toLowerCase()} design${count === 1 ? '' : 's'} with ${priced}?`)) return;
    setBusy(true);
    try {
      const pid = await ensureProject();
      const batch = crypto.randomUUID().slice(0, 12);
      for (let i = 0; i < count; i++) {
        const r = await api<{ job: { id: string }; credits: number }>('POST', '/api/jobs', {
          projectId: pid,
          kind: 'design',
          prompt,
          aspect: built.aspect,
          transparent: built.transparent,
          title: brief.name,
          useOwnKey: payWithKey,
          idempotencyKey: `design-${batch}-${i}`,
        });
        session.setCredits(r.credits);
        setPending((p) => [...p, { jobId: r.job.id, label: `${brief.name || info.label} #${i + 1}` }]);
        void waitFor(pid, r.job.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the design.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: Design) => {
    if (!projectId || !window.confirm(`Delete ${d.name}? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/projects/${projectId}/assets/${d.id}`);
      setDesigns((list) => list.filter((x) => x.id !== d.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that design.');
    }
  };

  /** Copies the design into a new animation project with a ready-made logo motion, then opens the editor. */
  const animate = async () => {
    if (!projectId || !animateFor || animating) return;
    setAnimating(true);
    setError('');
    try {
      const plan = logoAnimationPlan(animation);
      const base = emptyScene();
      const layer = { ...newObject('logo-layer', 'logo', animateFor.name.replace(/\.[^.]+$/, '')), widthPct: 30, ...plan.patch };
      const scene = { ...base, objects: [layer], scroll: { ...base.scroll, length: plan.scrollLength ?? base.scroll.length } };
      const label = LOGO_ANIMATIONS.find((a) => a.id === animation)?.label ?? 'Animation';
      const { project } = await api<{ project: { id: string } }>('POST', '/api/projects', { name: `${animateFor.name.replace(/-[0-9a-f]{8}\.[^.]+$/, '')} – ${label}`.slice(0, 80), scene });
      const blob = await (await fetch(`/api/projects/${projectId}/assets/${animateFor.id}`, { credentials: 'same-origin' })).blob();
      await uploadBinary(`/api/projects/${project.id}/assets/logo?name=${encodeURIComponent(animateFor.name)}`, blob);
      window.location.hash = `#/editor/${project.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the animation.');
      setAnimating(false);
    }
  };

  return (
    <div className="landing">
      <AppNav current="studio" />
      <div className="brand-head">
        <h1>Brand Studio</h1>
        <p className="muted">Create logos, flyers, product ads and mockups for your clients, then make any of them move.</p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {loading && <p className="muted">Loading…</p>}
      {!loading && (!tool || !tool.available) && (
        <div className="empty-card">
          <h2>Design generation is not set up yet</h2>
          <p className="muted">The server needs an image model. See DEPLOY.md: add a Replicate token, OpenAI image model or Cloudflare AI binding.</p>
        </div>
      )}

      {!loading && tool?.available && (
        <form className="brand-form" onSubmit={(e) => void generate(e)}>
          <div className="brand-types" role="radiogroup" aria-label="What to design">
            {DESIGN_TYPES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={brief.type === t.id} className={`brand-type${brief.type === t.id ? ' is-current' : ''}`} onClick={() => chooseType(t.id)}>
                <b>{t.label}</b>
                <span>{t.blurb}</span>
              </button>
            ))}
          </div>

          <div className="brand-grid">
            <label className="field"><span>{info.fields.name}</span>
              <input type="text" value={brief.name} maxLength={60} required onChange={(e) => set({ name: e.target.value })} placeholder={brief.type === 'logo' ? 'Aqua Vibe Shop' : ''} />
            </label>
            <label className="field"><span>{info.fields.tagline}</span>
              <input type="text" value={brief.tagline} maxLength={80} onChange={(e) => set({ tagline: e.target.value })} />
            </label>
            <label className="field wide"><span>{info.fields.about}</span>
              <input type="text" value={brief.about} maxLength={200} onChange={(e) => set({ about: e.target.value })} placeholder={brief.type === 'logo' ? 'a beachwear and pool toy shop in Trinidad' : ''} />
            </label>
            {info.fields.details && (
              <label className="field wide"><span>{info.fields.details}</span>
                <textarea rows={2} value={brief.details} maxLength={240} onChange={(e) => set({ details: e.target.value })} />
              </label>
            )}
            <label className="field"><span>Style</span>
              <select value={brief.styleId} onChange={(e) => set({ styleId: e.target.value })}>
                {info.styles.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <label className="field"><span>Colours (optional)</span>
              <input type="text" value={brief.colors} maxLength={120} onChange={(e) => set({ colors: e.target.value })} placeholder="ocean blue, sunny yellow" />
            </label>
            <label className="field wide"><span>Anything else (optional)</span>
              <input type="text" value={brief.notes} maxLength={300} onChange={(e) => set({ notes: e.target.value })} placeholder="include an octopus holding a beach ball" />
            </label>
          </div>

          <div className="row wrap">
            {brief.type === 'logo' && (
              <label className="check"><input type="checkbox" checked={brief.transparent} onChange={(e) => set({ transparent: e.target.checked })} /> Transparent background when the model supports it</label>
            )}
            <label className="check">Variations
              <select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="How many variations">
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            {tool.keyProvider && !ownKeyOnly && (
              <label className="check"><input type="checkbox" checked={useOwnKey} onChange={(e) => setUseOwnKey(e.target.checked)} /> Use my own {keyName(tool.keyProvider)} key</label>
            )}
          </div>

          <details className="brand-prompt">
            <summary>See or edit the full design prompt</summary>
            <textarea rows={6} maxLength={1500} value={prompt} onChange={(e) => setCustomPrompt(e.target.value)} aria-label="Design prompt" />
            {customPrompt !== null && <button type="button" className="btn small ghost" onClick={() => setCustomPrompt(null)}>Reset to the generated prompt</button>}
          </details>

          <div className="row between">
            <span className="muted">
              {payWithKey ? `Uses your own ${keyName(tool.keyProvider)} key${ownKeyOnly ? ' (connect it in Settings)' : ''}.` : `${total} credits · ${session.credits} available`}
              {tool.provider?.startsWith('workers-ai') ? ' · Square only; keep names short for clean lettering.' : ''}
            </span>
            <button type="submit" className="btn primary big" disabled={busy || !brief.name.trim()}>{busy ? 'Starting…' : `Create ${count === 1 ? 'design' : `${count} designs`}`}</button>
          </div>
        </form>
      )}

      {pending.length > 0 && (
        <ul className="brand-pending" aria-live="polite">
          {pending.map((p) => (
            <li key={p.jobId} className={p.error ? 'error' : ''}>
              {p.error ? `${p.label}: ${p.error}` : `Designing ${p.label}…`}
              {p.error && <button type="button" className="btn small ghost" onClick={() => setPending((l) => l.filter((x) => x.jobId !== p.jobId))}>Dismiss</button>}
            </li>
          ))}
        </ul>
      )}

      {designs.length > 0 && (
        <>
          <h2>Your designs</h2>
          <ul className="brand-gallery">
            {designs.map((d) => (
              <li key={d.id}>
                <img src={`/api/projects/${projectId}/assets/${d.id}`} alt={d.name} loading="lazy" />
                <div className="row">
                  <a className="btn small" href={`/api/projects/${projectId}/assets/${d.id}`} download={d.name}>Download</a>
                  <button type="button" className="btn small primary" onClick={() => setAnimateFor(d)}>Animate</button>
                  <button type="button" className="btn small danger" onClick={() => void remove(d)} aria-label={`Delete ${d.name}`}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
          <p className="muted small-print">A project holds up to 30 images, so download finished work and delete what you no longer need.</p>
        </>
      )}

      {animateFor && (
        <div className="brand-animate" role="dialog" aria-modal="true" aria-labelledby="animate-title">
          <div className="modal-card">
            <h2 id="animate-title">Make it move</h2>
            <p className="muted">Pick a starting motion. The design opens in the editor as its own project, where you can fine-tune the path, add effects and export it for any website.</p>
            <div className="brand-motions" role="radiogroup" aria-label="Motion">
              {LOGO_ANIMATIONS.map((a) => (
                <label key={a.id} className={`brand-type${animation === a.id ? ' is-current' : ''}`}>
                  <input type="radio" name="motion" value={a.id} checked={animation === a.id} onChange={() => setAnimation(a.id)} />
                  <b>{a.label}</b>
                  <span>{a.summary}</span>
                </label>
              ))}
            </div>
            <div className="row">
              <button type="button" className="btn" disabled={animating} onClick={() => setAnimateFor(null)}>Cancel</button>
              <button type="button" className="btn primary" disabled={animating} onClick={() => void animate()}>{animating ? 'Opening…' : 'Open in editor'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
