import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyEditCommand } from '../ai/commands';
import { buildAsset, loadImage, readFileAsDataUrl } from '../ai/imagePipeline';
import type { Stage } from '../ai/imagePipeline';
import { PROVIDER_SETS, getProviders } from '../ai/registry';
import type { GenerationMode } from '../ai/providers';
import { PathOverlay } from '../editor/PathOverlay';
import { useHistory } from '../editor/useHistory';
import { buildPreviewHtml, buildSnippet, buildStandaloneHtml, buildZip } from '../export/build';
import { sanitizeFilename, sanitizeText, slug, validateUpload } from '../lib/sanitize';
import { emptyScene, newObject } from '../scene/defaults';
import { EASINGS, parseScene } from '../scene/schema';
import type { Keyframe, Scene, SceneObject } from '../scene/schema';

interface Asset {
  id: string;
  name: string;
  source: string;
  frames: string[];
}

interface Saved {
  v: 1;
  scene: Scene;
  assets: { id: string; name: string; source: string }[];
  selectedId: string | null;
}

type Device = 'desktop' | 'tablet' | 'mobile';
const DEVICE_WIDTH: Record<Device, string> = { desktop: '100%', tablet: '768px', mobile: '390px' };
const STORAGE_KEY = 'motionforge.project.v1';
const STAGES: Stage[] = [
  'Analysing prompt',
  'Preparing image',
  'Removing background',
  'Generating motion',
  'Processing frames',
  'Optimising assets',
  'Building preview',
  'Complete',
];

type Job = { stage: Stage | 'Failed'; error?: string; retry?: () => void } | null;
interface LogLine {
  id: number;
  role: 'you' | 'ai';
  text: string;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const uid = (name: string) => `${slug(name, 'layer')}-${Math.random().toString(36).slice(2, 6)}`;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const three = (a: number[]) => [0, 0.5, 1].map((t) => window.MotionForge.sampleArray(a, t));

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Editor({ initialPrompt }: { initialPrompt: string }) {
  const history = useHistory<Scene>(emptyScene());
  const scene = history.state;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pointIdx, setPointIdx] = useState(0);
  const [device, setDevice] = useState<Device>('desktop');
  const [view, setView] = useState<'edit' | 'export'>('edit');
  const [mode, setMode] = useState<GenerationMode>('free');
  const [job, setJob] = useState<Job>(null);
  const [notice, setNotice] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt);
  const [log, setLog] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState(0);
  const [restoring, setRestoring] = useState(true);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [playing, setPlaying] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  const sel: SceneObject | null = scene.objects.find((o) => o.id === selectedId) ?? scene.objects[0] ?? null;
  const providers = getProviders(mode);

  const say = useCallback((role: LogLine['role'], text: string) => {
    setLog((l) => [...l.slice(-5), { id: Date.now() + Math.random(), role, text }]);
  }, []);

  const commit = useCallback((next: Scene, key?: string) => {
    const r = parseScene(next);
    if (!r.ok) {
      setNotice(`That change was not applied: ${r.error}`);
      return;
    }
    setNotice('');
    history.set(r.scene, key);
  }, [history.set]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchSel = (patch: Partial<SceneObject>, key?: string) => {
    if (!sel) return;
    commit({ ...scene, objects: scene.objects.map((o) => (o.id === sel.id ? { ...o, ...patch } : o)) }, key ?? `p-${Object.keys(patch)[0]}`);
  };

  // ---- persistence -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw) as Saved;
        const parsed = parseScene(saved.scene);
        if (saved.v !== 1 || !parsed.ok || !Array.isArray(saved.assets)) return;
        const rebuilt: Asset[] = [];
        for (const a of saved.assets) {
          const built = await buildAsset(a.source, () => undefined);
          rebuilt.push({ ...a, frames: built.frames });
        }
        if (cancelled) return;
        setAssets(rebuilt);
        history.reset(parsed.scene);
        setSelectedId(saved.selectedId);
      } catch {
        setNotice('Your previous project could not be restored, so a new one was started.');
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (restoring) return;
    setSaveState('saving');
    const t = setTimeout(() => {
      try {
        const data: Saved = {
          v: 1,
          scene,
          assets: assets.map(({ id, name, source }) => ({ id, name, source })),
          selectedId,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, 500);
    return () => clearTimeout(t);
  }, [scene, assets, selectedId, restoring]);

  // ---- preview bridge ----------------------------------------------------
  const framesMap = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a.frames])), [assets]);
  const previewHtml = useMemo(
    () => buildPreviewHtml({ scene: sceneRef.current, assets: framesMap }),
    [framesMap],
  );

  const post = useCallback((msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'), []);

  useEffect(() => {
    post({ type: 'mf-scene', scene });
  }, [scene, post]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { type?: string; p?: number };
      if (d?.type === 'mf-progress' && typeof d.p === 'number') setProgress(d.p);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);

  const scrub = useCallback(
    (p: number) => post({ type: 'mf-scroll', y: p * sceneRef.current.scroll.length }),
    [post],
  );

  const stop = useCallback(() => {
    if (playRef.current) cancelAnimationFrame(playRef.current);
    playRef.current = 0;
    setPlaying(false);
  }, []);

  const play = (dir: 1 | -1) => {
    stop();
    let p = progress;
    if (dir === 1 && p >= 0.999) p = 0;
    if (dir === -1 && p <= 0.001) p = 1;
    let last = performance.now();
    setPlaying(true);
    const step = (now: number) => {
      p = clamp(p + (dir * (now - last)) / 6000, 0, 1);
      last = now;
      scrub(p);
      if (p > 0 && p < 1) playRef.current = requestAnimationFrame(step);
      else stop();
    };
    playRef.current = requestAnimationFrame(step);
  };
  useEffect(() => stop, [stop]);

  // ---- assets ------------------------------------------------------------
  const runBuild = async (source: string, name: string, replaceId?: string) => {
    const attempt = async (): Promise<void> => {
      try {
        setJob({ stage: 'Preparing image' });
        const built = await buildAsset(source, (s) => setJob({ stage: s }));
        setJob({ stage: 'Building preview' });
        await wait(250);
        const id = replaceId ?? uid(name);
        if (replaceId) {
          setAssets((prev) => prev.map((a) => (a.id === replaceId ? { ...a, name, source, frames: built.frames } : a)));
        } else {
          setAssets((prev) => [...prev, { id, name, source, frames: built.frames }]);
          const obj = newObject(id, id, name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Layer');
          commit({ ...sceneRef.current, objects: [...sceneRef.current.objects, obj] });
          setSelectedId(id);
        }
        setJob({ stage: 'Complete' });
        say('ai', built.backgroundRemoved ? 'Background removed and motion frames created.' : 'Transparent image detected, so its background was kept as is. Motion frames created.');
        setTimeout(() => setJob((j) => (j?.stage === 'Complete' ? null : j)), 1500);
      } catch (e) {
        setJob({ stage: 'Failed', error: e instanceof Error ? e.message : 'Something went wrong.', retry: attempt });
      }
    };
    await attempt();
  };

  const onFiles = async (files: FileList | null, replaceId?: string) => {
    const file = files?.[0];
    if (!file) return;
    const problem = validateUpload(file);
    if (problem) {
      setNotice(problem);
      return;
    }
    setNotice('');
    try {
      const data = await readFileAsDataUrl(file);
      await loadImage(data);
      await runBuild(data, sanitizeFilename(file.name), replaceId);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'That image could not be used.');
    }
  };

  const useSample = async () => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}sample-bird.svg`);
      const blob = await res.blob();
      const data = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('Could not load the sample bird.'));
        fr.readAsDataURL(blob);
      });
      await runBuild(data, 'sample-bird.png');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not load the sample bird.');
    }
  };

  const deleteAsset = (a: Asset) => {
    if (!window.confirm(`Delete "${a.name}" and any layers that use it?`)) return;
    setAssets((prev) => prev.filter((x) => x.id !== a.id));
    commit({ ...scene, objects: scene.objects.filter((o) => o.assetId !== a.id) });
  };

  // ---- layers ------------------------------------------------------------
  const addLayerFor = (a: Asset) => {
    const obj = newObject(uid(a.name), a.id, a.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Layer');
    commit({ ...scene, objects: [...scene.objects, obj] });
    setSelectedId(obj.id);
  };

  const duplicate = (o: SceneObject) => {
    const copy: SceneObject = {
      ...o,
      id: uid(o.name),
      name: `${o.name} copy`.slice(0, 60),
      path: o.path.map((k) => ({ ...k, x: Math.round((k.x + 6) * 10) / 10, y: Math.round((k.y + 6) * 10) / 10 })),
    };
    commit({ ...scene, objects: [...scene.objects, copy] });
    setSelectedId(copy.id);
  };

  const removeLayer = (o: SceneObject) => {
    commit({ ...scene, objects: scene.objects.filter((x) => x.id !== o.id) });
    setSelectedId(null);
  };

  const moveLayer = (o: SceneObject, dir: -1 | 1) => {
    const i = scene.objects.findIndex((x) => x.id === o.id);
    const j = i + dir;
    if (j < 0 || j >= scene.objects.length) return;
    const objects = [...scene.objects];
    [objects[i], objects[j]] = [objects[j], objects[i]];
    commit({ ...scene, objects });
  };

  // ---- path --------------------------------------------------------------
  const setPath = (path: Keyframe[], key: string) => patchSel({ path }, key);
  const addPoint = () => {
    if (!sel) return;
    const p = [...sel.path].sort((a, b) => a.progress - b.progress);
    let gap = 0;
    for (let i = 1; i < p.length; i++) if (p[i].progress - p[i - 1].progress > p[gap + 1 < p.length ? gap + 1 : 1].progress - p[gap].progress) gap = i - 1;
    const mid = (p[gap].progress + p[gap + 1].progress) / 2;
    const pos = window.MotionForge.samplePath(p, mid);
    p.splice(gap + 1, 0, { progress: Math.round(mid * 1000) / 1000, x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10 });
    patchSel({ path: p }, 'path-add');
    setPointIdx(gap + 1);
  };
  const removePoint = () => {
    if (!sel || sel.path.length <= 2) return;
    const path = sel.path.filter((_, i) => i !== pointIdx);
    patchSel({ path }, 'path-remove');
    setPointIdx(0);
  };

  // ---- prompt ------------------------------------------------------------
  const submitPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = sanitizeText(prompt);
    if (!text) return;
    say('you', text);
    setPrompt('');
    const targetId = sel?.id ?? null;
    const edit = applyEditCommand(text, scene, targetId);
    if (edit) {
      if (edit.scene !== scene) commit(edit.scene);
      say('ai', edit.message);
      return;
    }
    if (!sel) {
      say('ai', 'Upload an image or use the sample bird first, then describe how it should move.');
      return;
    }
    const attempt = async (): Promise<void> => {
      try {
        setJob({ stage: 'Analysing prompt' });
        await wait(300);
        const plan = await providers.planner.plan(text);
        setJob({ stage: 'Building preview' });
        await wait(250);
        const cur = sceneRef.current;
        commit({
          ...cur,
          objects: cur.objects.map((o) => (o.id === sel.id ? { ...o, ...plan.patch } : o)),
          scroll: { ...cur.scroll, length: plan.scrollLength ?? cur.scroll.length },
        });
        setPointIdx(0);
        setJob({ stage: 'Complete' });
        say('ai', plan.summary);
        setTimeout(() => setJob((j) => (j?.stage === 'Complete' ? null : j)), 1200);
      } catch (err) {
        setJob({ stage: 'Failed', error: err instanceof Error ? err.message : 'Planning failed.', retry: attempt });
      }
    };
    await attempt();
  };

  // ---- keyboard shortcuts --------------------------------------------------
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [history.undo, history.redo]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasObjects = scene.objects.length > 0;

  // ---- export view -------------------------------------------------------
  if (view === 'export') {
    return (
      <ExportView
        scene={scene}
        assets={framesMap}
        onBack={() => setView('edit')}
      />
    );
  }

  return (
    <div className="editor">
      <header className="ed-top">
        <a className="brand" href="#/">MotionForge <span>AI</span></a>
        <div className="ed-top-group">
          <label className="inline">
            <span className="sr-only">Generation mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as GenerationMode)} aria-label="Generation mode">
              {Object.values(PROVIDER_SETS).map((p) => (
                <option key={p.mode} value={p.mode} disabled={!p.available}>
                  {p.label}{p.available ? '' : ' (needs server)'}
                </option>
              ))}
            </select>
          </label>
          <div className="seg" role="group" aria-label="Preview size">
            {(['desktop', 'tablet', 'mobile'] as Device[]).map((d) => (
              <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)}>
                {d[0].toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="ed-top-group">
          <button type="button" className="btn ghost" onClick={history.undo} disabled={!history.canUndo}>Undo</button>
          <button type="button" className="btn ghost" onClick={history.redo} disabled={!history.canRedo}>Redo</button>
          <span className={`save save-${saveState}`} role="status">
            {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Could not save (storage full)'}
          </span>
          <button type="button" className="btn primary" onClick={() => setView('export')} disabled={!hasObjects}>
            Export
          </button>
        </div>
      </header>

      {notice && (
        <div className="banner" role="alert">
          {notice} <button type="button" className="link" onClick={() => setNotice('')}>Dismiss</button>
        </div>
      )}

      <div className="ed-main">
        <aside className="panel left" aria-label="Assets and layers">
          <h2>Images</h2>
          <div className="row">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>Upload image</button>
            <button type="button" className="btn ghost" onClick={useSample}>Use sample bird</button>
          </div>
          <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
          <input ref={replaceRef} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => { void onFiles(e.target.files, replaceTarget.current ?? undefined); e.target.value = ''; }} />
          {restoring && <p className="muted">Restoring your project…</p>}
          {!restoring && assets.length === 0 && <p className="muted">PNG, JPG or WebP up to 10 MB. Transparent PNGs work best.</p>}
          <ul className="list">
            {assets.map((a) => (
              <li key={a.id} className="asset">
                <img src={a.frames[0]} alt="" />
                <span className="grow" title={a.name}>{a.name}</span>
                <button type="button" className="btn small ghost" onClick={() => addLayerFor(a)} aria-label={`Add another layer using ${a.name}`}>+ Layer</button>
                <button type="button" className="btn small ghost" onClick={() => { replaceTarget.current = a.id; replaceRef.current?.click(); }} aria-label={`Replace ${a.name}`}>Replace</button>
                <button type="button" className="btn small ghost danger" onClick={() => deleteAsset(a)} aria-label={`Delete ${a.name}`}>Delete</button>
              </li>
            ))}
          </ul>

          <h2>Layers</h2>
          {!hasObjects && <p className="muted">Layers appear here once you add an image. The last layer is drawn on top.</p>}
          <ul className="list">
            {scene.objects.map((o) => (
              <li key={o.id} className={`layer${sel?.id === o.id ? ' is-selected' : ''}`}>
                <button type="button" className="layer-name" onClick={() => { setSelectedId(o.id); setPointIdx(0); }} aria-pressed={sel?.id === o.id}>{o.name}</button>
                <button type="button" className="btn small ghost" onClick={() => moveLayer(o, -1)} aria-label={`Move ${o.name} backward`}>↓</button>
                <button type="button" className="btn small ghost" onClick={() => moveLayer(o, 1)} aria-label={`Move ${o.name} forward`}>↑</button>
                <button type="button" className="btn small ghost" onClick={() => duplicate(o)} aria-label={`Duplicate ${o.name}`}>Copy</button>
                <button type="button" className="btn small ghost danger" onClick={() => removeLayer(o)} aria-label={`Delete layer ${o.name}`}>✕</button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="center" aria-label="Live preview">
          {hasObjects ? (
            <div className="frame" style={{ width: DEVICE_WIDTH[device] }}>
              <iframe
                ref={iframeRef}
                title="Scroll animation preview"
                sandbox="allow-scripts"
                srcDoc={previewHtml}
                onLoad={() => post({ type: 'mf-scene', scene: sceneRef.current })}
              />
              {sel && !sel.pinned && (
                <PathOverlay obj={sel} selected={pointIdx} onSelect={setPointIdx} onChange={setPath} />
              )}
            </div>
          ) : (
            <div className="empty">
              <h1>Start with an image</h1>
              <p>Upload a picture, or try the sample bird, then describe how it should move as people scroll.</p>
              <button type="button" className="btn primary" onClick={useSample}>Try the sample bird</button>
            </div>
          )}
          {hasObjects && <p className="hint">Scroll inside the preview, or use the timeline below. Drag the numbered handles to reshape the path.</p>}
        </main>

        <aside className="panel right" aria-label="Properties">
          <h2>Properties</h2>
          {!sel && <p className="muted">Select a layer to edit it.</p>}
          {sel && (
            <>
              <label className="field">
                <span>Name</span>
                <input type="text" maxLength={60} value={sel.name} onChange={(e) => patchSel({ name: e.target.value || 'Layer' }, 'name')} />
              </label>
              <Slider label="Size (% of width)" min={2} max={100} step={1} value={sel.widthPct} onChange={(v) => patchSel({ widthPct: v })} />
              <Slider label="Mobile size multiplier" min={0.2} max={2} step={0.05} value={sel.mobileScale} onChange={(v) => patchSel({ mobileScale: v })} />
              <Slider label="Wing flaps per scroll" min={0} max={60} step={1} value={sel.flapsPerScroll} onChange={(v) => patchSel({ flapsPerScroll: v })} />
              <Slider label="Body rise & fall" min={0} max={10} step={0.1} value={sel.bob} onChange={(v) => patchSel({ bob: v })} />
              <Triple label="Rotation (°)" min={-180} max={180} step={1} values={three(sel.rotation)} onChange={(v) => patchSel({ rotation: v }, 'rotation')} />
              <Triple label="Scale" min={0.1} max={3} step={0.05} values={three(sel.scale)} onChange={(v) => patchSel({ scale: v }, 'scale')} />
              <Triple label="Opacity" min={0} max={1} step={0.05} values={three(sel.opacity)} onChange={(v) => patchSel({ opacity: v }, 'opacity')} />
              <Triple label="Blur (px)" min={0} max={20} step={0.5} values={three(sel.blur)} onChange={(v) => patchSel({ blur: v }, 'blur')} />
              <Slider label="Starts at (% of scroll)" min={0} max={95} step={1} value={Math.round(sel.start * 100)} onChange={(v) => patchSel({ start: Math.min(v / 100, sel.end - 0.05) }, 'start')} />
              <Slider label="Ends at (% of scroll)" min={5} max={100} step={1} value={Math.round(sel.end * 100)} onChange={(v) => patchSel({ end: Math.max(v / 100, sel.start + 0.05) }, 'end')} />
              <label className="field">
                <span>Easing</span>
                <select value={sel.easing} onChange={(e) => patchSel({ easing: e.target.value as SceneObject['easing'] })}>
                  {EASINGS.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={sel.followPath} onChange={(e) => patchSel({ followPath: e.target.checked })} /> Tilt to follow the path</label>
              <label className="check"><input type="checkbox" checked={sel.pinned} onChange={(e) => patchSel({ pinned: e.target.checked })} /> Pin to the viewport</label>

              <h3>Motion path</h3>
              <div className="row">
                <button type="button" className="btn small" onClick={addPoint} disabled={sel.pinned || sel.path.length >= 24}>Add point</button>
                <button type="button" className="btn small ghost danger" onClick={removePoint} disabled={sel.pinned || sel.path.length <= 2}>Remove point {pointIdx + 1}</button>
              </div>
              {sel.path[pointIdx] && !sel.pinned && (
                <div className="row">
                  <label className="field half"><span>X %</span>
                    <input type="number" step={1} value={sel.path[pointIdx].x} onChange={(e) => setPath(sel.path.map((k, i) => (i === pointIdx ? { ...k, x: Number(e.target.value) } : k)), `path-${pointIdx}`)} />
                  </label>
                  <label className="field half"><span>Y %</span>
                    <input type="number" step={1} value={sel.path[pointIdx].y} onChange={(e) => setPath(sel.path.map((k, i) => (i === pointIdx ? { ...k, y: Number(e.target.value) } : k)), `path-${pointIdx}`)} />
                  </label>
                </div>
              )}
            </>
          )}

          <h3>Scroll</h3>
          <Slider label="Scroll length (px)" min={300} max={8000} step={50} value={scene.scroll.length} onChange={(v) => commit({ ...scene, scroll: { ...scene.scroll, length: v } }, 'scroll-length')} />
          <Slider label="Smoothing" min={0} max={1} step={0.05} value={scene.scroll.smoothing} onChange={(v) => commit({ ...scene, scroll: { ...scene.scroll, smoothing: v } }, 'smoothing')} />
          <label className="check"><input type="checkbox" checked={scene.scroll.reverse} onChange={(e) => commit({ ...scene, scroll: { ...scene.scroll, reverse: e.target.checked } })} /> Reverse when scrolling up</label>
        </aside>
      </div>

      <section className="timeline" aria-label="Scroll timeline">
        <div className="row">
          <button type="button" className="btn small" onClick={() => play(-1)} disabled={!hasObjects}>◀ Play reverse</button>
          <button type="button" className="btn small" onClick={() => (playing ? stop() : play(1))} disabled={!hasObjects}>{playing ? 'Stop' : 'Play forward ▶'}</button>
          <span className="muted mono">{Math.round(progress * 100)}% · {Math.round(progress * scene.scroll.length)}px</span>
        </div>
        <div className="track">
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            disabled={!hasObjects}
            aria-label="Scroll position"
            onChange={(e) => { stop(); scrub(Number(e.target.value) / 1000); }}
          />
          {sel && sel.path.map((k, i) => (
            <span key={i} className={`tick${i === pointIdx ? ' is-selected' : ''}`} style={{ left: `${k.progress * 100}%` }} title={`Path point ${i + 1}`} />
          ))}
        </div>
      </section>

      {job && <JobStatus job={job} onClose={() => setJob(null)} />}

      <div className="promptbar">
        <div className="log" aria-live="polite">
          {log.map((l) => <p key={l.id} className={l.role}><b>{l.role === 'you' ? 'You' : 'MotionForge'}:</b> {l.text}</p>)}
        </div>
        <form onSubmit={(e) => void submitPrompt(e)}>
          <label className="sr-only" htmlFor="prompt">Describe the animation or ask for a change</label>
          <input
            id="prompt"
            type="text"
            maxLength={500}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Make this bird flap its wings and fly along a curved path from the bottom-left to the top-right"
          />
          <button type="submit" className="btn primary" disabled={!prompt.trim() || (job !== null && job.stage !== 'Failed' && job.stage !== 'Complete')}>Send</button>
        </form>
        <p className="muted small-note">
          Using {providers.planner.id} · {providers.backgroundRemover.id} · {providers.motionFrames.id} · estimated cost: 0 credits
          {mode !== providers.mode ? '' : ''}
        </p>
      </div>
    </div>
  );
}

function JobStatus({ job, onClose }: { job: NonNullable<Job>; onClose: () => void }) {
  const idx = STAGES.indexOf(job.stage as Stage);
  return (
    <div className="job" role="status" aria-live="polite">
      <ol>
        {STAGES.map((s, i) => (
          <li key={s} className={job.stage === 'Failed' ? '' : i < idx ? 'done' : i === idx ? 'now' : ''}>{s}</li>
        ))}
        {job.stage === 'Failed' && <li className="failed">Failed</li>}
      </ol>
      {job.stage === 'Failed' && (
        <p>
          {job.error} No credits were used.{' '}
          {job.retry && <button type="button" className="btn small" onClick={job.retry}>Retry</button>}{' '}
          <button type="button" className="btn small ghost" onClick={onClose}>Dismiss</button>
        </p>
      )}
    </div>
  );
}

function Slider(props: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{props.label}<output>{Math.round(props.value * 100) / 100}</output></span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

function Triple(props: { label: string; min: number; max: number; step: number; values: number[]; onChange: (v: number[]) => void }) {
  const names = ['Start', 'Middle', 'End'];
  return (
    <fieldset className="triple">
      <legend>{props.label}</legend>
      {props.values.map((v, i) => (
        <label key={i} className="field mini">
          <span>{names[i]}<output>{Math.round(v * 100) / 100}</output></span>
          <input type="range" min={props.min} max={props.max} step={props.step} value={v} onChange={(e) => props.onChange(props.values.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
        </label>
      ))}
    </fieldset>
  );
}

function ExportView({ scene, assets, onBack }: { scene: Scene; assets: Record<string, string[]>; onBack: () => void }) {
  const [msg, setMsg] = useState('');
  const input = useMemo(() => ({ scene, assets }), [scene, assets]);
  const html = useMemo(() => buildStandaloneHtml(input), [input]);
  const kb = Math.round(html.length / 1024);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildSnippet(input));
      setMsg('Embed snippet copied.');
    } catch {
      setMsg('Your browser blocked copying. Download the HTML file instead.');
    }
  };

  return (
    <div className="export">
      <header className="ed-top">
        <a className="brand" href="#/">MotionForge <span>AI</span></a>
        <button type="button" className="btn ghost" onClick={onBack}>← Back to editor</button>
      </header>
      <div className="export-grid">
        <section>
          <h1>Export</h1>
          <p className="muted">This is exactly what your visitors get. It runs on its own: no account, no API keys, no connection to MotionForge.</p>
          <div className="row wrap">
            <button type="button" className="btn primary" onClick={() => download('motionforge-animation.html', html, 'text/html')}>Download standalone HTML</button>
            <button type="button" className="btn" onClick={() => void copy()}>Copy embed snippet</button>
            <button type="button" className="btn" onClick={() => download('motionforge-bundle.zip', buildZip(input), 'application/zip')}>Download self-host ZIP</button>
          </div>
          <p role="status" className="muted">{msg || `Standalone file size: about ${kb} KB.`}</p>

          <h2>Install</h2>
          <details open>
            <summary>Any website (HTML)</summary>
            <p>Paste the embed snippet where the animation should begin. It needs about {scene.scroll.length}px of scrolling room below that point and nothing with <code>overflow:hidden</code> around it.</p>
          </details>
          <details>
            <summary>Webflow</summary>
            <p>The ZIP includes <code>snippet-hosted.html</code>. Host the files from the ZIP, paste the snippet into an Embed element and replace <code>BASE_URL</code>. This keeps you inside Webflow's embed size limit.</p>
          </details>
          <details>
            <summary>WordPress</summary>
            <p>Add a Custom HTML block. For small animations paste the embed snippet. For larger ones upload the ZIP contents to your media folder and use <code>snippet-hosted.html</code>.</p>
          </details>
          <details>
            <summary>React / Next.js</summary>
            <p>The ZIP includes <code>MotionForgeScene.jsx</code>. Copy it with <code>motionforge.js</code> and <code>scene.json</code>, and put <code>frames/</code> in <code>public/motionforge/frames</code>.</p>
          </details>
          <details>
            <summary>Reduced motion</summary>
            <p>Visitors who turn on “reduce motion” in their system see a still frame instead of a scroll animation.</p>
          </details>
        </section>
        <section className="export-preview" aria-label="Export preview">
          <iframe title="Export preview" sandbox="allow-scripts" srcDoc={html} />
        </section>
      </div>
    </div>
  );
}
