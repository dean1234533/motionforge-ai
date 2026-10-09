import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyEditCommand } from '../ai/commands';
import { buildAsset, encodeCanvas, loadImage, readFileAsDataUrl } from '../ai/imagePipeline';
import { cleanFlightFrame, flightFrameCrop } from '../ai/flightFrame';
import { isSubjectAction, requiresActionFrames } from '../ai/actionMotion';
import type { Stage } from '../ai/imagePipeline';
import { PROVIDER_SETS, getProviders } from '../ai/registry';
import type { GenerationMode } from '../ai/providers';
import { PathOverlay } from '../editor/PathOverlay';
import { useHistory } from '../editor/useHistory';
import { buildPreviewHtml, buildSnippet, buildStandaloneHtml, buildZip } from '../export/build';
import type { ExportOptions } from '../export/build';
import { sanitizeFilename, sanitizeText, slug, validateUpload } from '../lib/sanitize';
import { EFFECT_LABELS, emptyScene, newEffect, newLine, newObject, newShape } from '../scene/defaults';
import { EASINGS, EFFECT_TYPES, parseScene } from '../scene/schema';
import type { EffectSettings, EffectType, Keyframe, LineSettings, Scene, SceneObject, ShapeSettings } from '../scene/schema';
import { extractFrames } from '../ai/videoFrames';
import { chromaScreenBlob, toUploadBlob } from '../ai/imagePipeline';
import type { KeyColor } from '../ai/chromaKey';
import { api, uploadBinary, when } from '../lib/api';
import { useSession } from '../lib/session';

interface Asset {
  id: string;
  name: string;
  source: string;
  frames: string[];
  /** Upscaled images get higher-resolution frames. */
  hd?: boolean;
  sequence?: 'bird-flight';
}

interface MotionReview {
  generatedAssetId: string;
  targetId: string;
  assetId: string;
  frames: string[];
  patch: Partial<SceneObject>;
  scrollLength?: number;
  prompt: string;
}

interface ToolInfo {
  kind: 'image-gen' | 'upscale';
  label: string;
  cost: number;
  provider: string | null;
  keyProvider: string | null;
  available: boolean;
  platformKey: boolean;
}

interface Saved {
  v: 1;
  scene: Scene;
  assets: { id: string; name: string; source: string; sequence?: 'bird-flight' }[];
  selectedId: string | null;
}

type Device = 'desktop' | 'tablet' | 'mobile';

/** The editing controls are split into tabs, one group per tab. */
type LeftTab = 'media' | 'add' | 'layers';
type RightTab = 'layer' | 'look' | 'timing' | 'path' | 'scroll';
const LEFT_TABS: { id: LeftTab; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'add', label: 'Add' },
  { id: 'layers', label: 'Layers' },
];
const RIGHT_TABS: { id: RightTab; label: string }[] = [
  { id: 'layer', label: 'Layer' },
  { id: 'look', label: 'Look' },
  { id: 'timing', label: 'Timing' },
  { id: 'path', label: 'Path' },
  { id: 'scroll', label: 'Scroll' },
];
const TAB_KEY = 'motionforge.tabs';
function readTab<T extends string>(side: 'left' | 'right', tabs: { id: T }[], fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(TAB_KEY) ?? '{}')[side];
    return tabs.some((t) => t.id === v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveTab(side: 'left' | 'right', value: string) {
  try {
    const cur = JSON.parse(localStorage.getItem(TAB_KEY) ?? '{}');
    localStorage.setItem(TAB_KEY, JSON.stringify({ ...cur, [side]: value }));
  } catch {
    /* remembering the tab is a nicety */
  }
}
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

interface ModeInfo {
  mode: GenerationMode;
  label: string;
  cost: number;
  provider: string | null;
  generatesMotion?: boolean;
  available: boolean;
}

interface ServerJob {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  stage: string;
  error: string | null;
  result: { plan: { patch: Partial<SceneObject>; scrollLength?: number; summary: string } | null; videoUrl: string | null; assetId?: string | null } | null;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const uid = (name: string) => `${slug(name, 'layer')}-${Math.random().toString(36).slice(2, 6)}`;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const three = (a: number[]) => [0, 0.5, 1].map((t) => window.MotionForge.sampleArray(a, t));
const FLIGHT_ROUTES: Record<string, Keyframe[]> = {
  right: [{ progress: 0, x: 20, y: 50 }, { progress: 1, x: 80, y: 50 }],
  left: [{ progress: 0, x: 80, y: 50 }, { progress: 1, x: 20, y: 50 }],
  up: [{ progress: 0, x: 50, y: 80 }, { progress: 1, x: 50, y: 20 }],
  down: [{ progress: 0, x: 50, y: 20 }, { progress: 1, x: 50, y: 80 }],
  return: [{ progress: 0, x: 50, y: 80 }, { progress: 0.5, x: 50, y: 20 }, { progress: 1, x: 50, y: 80 }],
};

async function birdFlightFrames(): Promise<string[]> {
  const sheet = await loadImage(`${import.meta.env.BASE_URL}bird-flight.png`);
  const frames: string[] = [];
  for (let i = 0; i < 16; i++) {
    const crop = flightFrameCrop(sheet.naturalWidth, sheet.naturalHeight, i);
    const { width, height } = crop;
    const cell = document.createElement('canvas');
    cell.width = width;
    cell.height = height;
    const ctx = cell.getContext('2d')!;
    // Drawing the sheet at an offset supplies transparent padding at its outer
    // edges while recovering wing tips beyond an internal grid boundary.
    ctx.drawImage(sheet, -crop.x, -crop.y);
    // Align the orange breast rather than the wing bounds, which change every
    // frame. This keeps the torso steady throughout the generated wingbeat.
    const image = ctx.getImageData(0, 0, width, height);
    cleanFlightFrame(image.data, width, height);
    ctx.putImageData(image, 0, 0);
    const pixels = image.data;
    let sx = 0, sy = 0, weight = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
      if (pixels[p + 3] > 128 && r > 100 && g > 45 && r > g * 1.5 && g > b * 1.5) {
        const w = r - b;
        sx += x * w; sy += y * w; weight += w;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 768;
    const scaleX = 512 / crop.cellWidth, scaleY = 512 / crop.cellHeight;
    const dx = weight ? 768 * 0.65 - (sx / weight) * scaleX : 128;
    const dy = weight ? 768 * 0.55 - (sy / weight) * scaleY : 128;
    canvas.getContext('2d')!.drawImage(cell, dx, dy, width * scaleX, height * scaleY);
    frames.push(encodeCanvas(canvas));
  }
  return frames;
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Editor({ initialPrompt, projectId, autoBird = false }: { initialPrompt: string; projectId?: string; autoBird?: boolean }) {
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
  const [motionReview, setMotionReview] = useState<MotionReview | null>(null);
  const activeMotionPrompt = useRef('');
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
  const starterLoaded = useRef(false);

  const sel: SceneObject | null = scene.objects.find((o) => o.id === selectedId) ?? scene.objects[0] ?? null;
  const providers = getProviders(mode);
  const session = useSession();
  const paidPlan = session.user?.plan === 'creator' || session.user?.plan === 'professional';
  /** Paid plans get higher-resolution frames. */
  const frameSide = paidPlan ? 1024 : 512;
  const [serverModes, setServerModes] = useState<ModeInfo[]>([]);
  const [showShare, setShowShare] = useState(false);
  const aborted = useRef(false);
  /** True while there are edits the server has not confirmed yet. */
  const dirty = useRef(false);
  /** The temporary chroma-screen copy of an image sent to a video model. */
  const chroma = useRef<{ id: string; key: KeyColor } | null>(null);
  const modeInfo = serverModes.find((m) => m.mode === mode);
  const [serverTools, setServerTools] = useState<ToolInfo[]>([]);
  /** Which server settings exist (yes/no only), so a missing one can be named. */
  const [setup, setSetup] = useState<Record<string, boolean> | null>(null);
  const [role, setRole] = useState<'owner' | 'editor' | 'viewer'>('owner');
  const [aiPrompt, setAiPrompt] = useState('');
  const [payWithKey, setPayWithKey] = useState(false);
  const [fxType, setFxType] = useState<EffectType>('smoke');
  const [leftTab, setLeftTabState] = useState<LeftTab>(() => readTab('left', LEFT_TABS, 'media'));
  const [rightTab, setRightTabState] = useState<RightTab>(() => readTab('right', RIGHT_TABS, 'layer'));
  const setLeftTab = (t: LeftTab) => {
    setLeftTabState(t);
    saveTab('left', t);
  };
  const setRightTab = (t: RightTab) => {
    setRightTabState(t);
    saveTab('right', t);
  };
  const [shapeType, setShapeType] = useState<ShapeSettings['type']>('circle');
  const readOnly = role === 'viewer';

  useEffect(() => {
    aborted.current = false;
    return () => {
      aborted.current = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    api<{ modes: ModeInfo[]; tools: ToolInfo[]; balance: number; setup?: Record<string, boolean> }>('GET', '/api/modes')
      .then((r) => {
        setSetup(r.setup ?? null);
        setServerModes(r.modes);
        setServerTools(r.tools);
        session.setCredits(r.balance);
      })
      .catch(() => undefined);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (projectId) {
          const { project } = await api<{ project: { name: string; scene: unknown; role: 'owner' | 'editor' | 'viewer' } }>('GET', `/api/projects/${projectId}`);
          const parsedScene = parseScene(project.scene);
          if (!parsedScene.ok) throw new Error(parsedScene.error);
          setRole(project.role);
          const { assets: list } = await api<{ assets: { id: string; name: string; hasFrames: boolean; hd: boolean }[] }>('GET', `/api/projects/${projectId}/assets`);
          const restored: Asset[] = [];
          for (const a of list.filter((x) => !x.id.startsWith('gs-'))) {
            const blob = await (await fetch(`/api/projects/${projectId}/assets/${a.id}`, { credentials: 'same-origin' })).blob();
            const source = await readFileAsDataUrl(new File([blob], a.name, { type: blob.type }));
            let frames: string[] | null = null;
            if (a.hasFrames) {
              const fr = await fetch(`/api/projects/${projectId}/assets/${a.id}/frames`, { credentials: 'same-origin' });
              if (fr.ok) frames = (await fr.json()) as string[];
            }
            restored.push({ id: a.id, name: a.name, source, hd: a.hd, frames: frames ?? (await buildAsset(source, () => undefined, a.hd || paidPlan ? 1024 : 512)).frames });
          }
          if (cancelled) return;
          setAssets(restored);
          history.reset(parsedScene.scene);
          return;
        }
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw) as Saved;
        const parsed = parseScene(saved.scene);
        if (saved.v !== 1 || !parsed.ok || !Array.isArray(saved.assets)) return;
        const rebuilt: Asset[] = [];
        for (const a of saved.assets) {
          if (a.sequence === 'bird-flight') {
            rebuilt.push({ ...a, frames: await birdFlightFrames() });
            continue;
          }
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
    if (projectId && !readOnly) dirty.current = true;
    const t = setTimeout(() => {
      if (projectId) {
        if (readOnly) return;
        api('PUT', `/api/projects/${projectId}`, { scene })
          .then(() => {
            dirty.current = false;
            setSaveState('saved');
          })
          .catch(() => setSaveState('error'));
        return;
      }
      try {
        const data: Saved = {
          v: 1,
          scene,
          assets: assets.map(({ id, name, source, sequence }) => ({ id, name, source, sequence })),
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

  // If the page is closed or reloaded before the half-second autosave fires, still send the last edit.
  useEffect(() => {
    if (!projectId) return;
    const flush = () => {
      if (!dirty.current) return;
      dirty.current = false;
      void fetch(`/api/projects/${projectId}`, {
        method: 'PUT',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'motionforge', 'content-type': 'application/json' },
        body: JSON.stringify({ scene: sceneRef.current }),
      }).catch(() => undefined);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [projectId]);

  // ---- preview bridge ----------------------------------------------------
  const framesMap = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a.frames])), [assets]);
  const previewFrames = useMemo(() => motionReview ? { ...framesMap, [motionReview.generatedAssetId]: motionReview.frames } : framesMap, [framesMap, motionReview]);
  const previewScene = useMemo(() => motionReview ? {
    ...scene,
    objects: scene.objects.map((o) => o.id === motionReview.targetId ? { ...o, ...motionReview.patch, assetId: motionReview.generatedAssetId } : o),
    scroll: { ...scene.scroll, length: motionReview.scrollLength ?? scene.scroll.length },
  } : scene, [scene, motionReview]);
  const previewSceneRef = useRef(previewScene);
  previewSceneRef.current = previewScene;
  const previewHtml = useMemo(
    () => buildPreviewHtml({ scene: previewSceneRef.current, assets: previewFrames }),
    [previewFrames],
  );

  const post = useCallback((msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'), []);

  useEffect(() => {
    post({ type: 'mf-scene', scene: previewScene });
  }, [previewScene, post]);

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
    (p: number) => post({ type: 'mf-scroll', y: p * previewSceneRef.current.scroll.length }),
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
        const built = await buildAsset(source, (s) => setJob({ stage: s }), frameSide);
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
        if (projectId) {
          await uploadBinary(`/api/projects/${projectId}/assets/${id}?name=${encodeURIComponent(name)}`, await toUploadBlob(source));
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

  const useSample = async () => { await useBirdFlight('sample-bird', false); };

  const useBirdFlight = async (name = 'Robin flight', replaceSelected = true) => {
    try {
      setJob({ stage: 'Processing frames' });
      const frames = await birdFlightFrames();
      const assetId = uid('bird-flight');
      const asset: Asset = { id: assetId, name, source: frames[0], frames, sequence: 'bird-flight' };
      if (projectId) {
        await uploadBinary(`/api/projects/${projectId}/assets/${assetId}?name=Robin%20flight`, await toUploadBlob(frames[0]));
        await api('PUT', `/api/projects/${projectId}/assets/${assetId}/frames`, frames);
      }
      const replacing = replaceSelected && sel?.kind === 'image';
      const object = replacing ? { ...sel!, assetId, name, flapsPerScroll: 8, widthPct: Math.min(100, sel!.widthPct * (sel!.name === 'Robin flight' ? 1 : 1.5)) }
        : { ...newObject(uid('robin'), assetId, name), flapsPerScroll: 8, widthPct: 33, path: [{ progress: 0, x: 50, y: 80 }, { progress: 0.5, x: 32.6, y: 56 }, { progress: 1, x: 56.6, y: 31.7 }] };
      setAssets((prev) => [...prev, asset]);
      commit({ ...sceneRef.current, objects: replacing
        ? sceneRef.current.objects.map((o) => o.id === sel.id ? object : o)
        : [...sceneRef.current.objects, object] });
      setSelectedId(object.id);
      setJob(null);
      say('ai', 'Motion frames created from the updated robin flight sequence. Each frame has its own wing pose.');
    } catch (e) {
      setJob(null);
      setNotice(e instanceof Error ? e.message : 'Could not load the bird flight.');
    }
  };

  const deleteAsset = (a: Asset) => {
    if (!window.confirm(`Delete "${a.name}" and any layers that use it?`)) return;
    setAssets((prev) => prev.filter((x) => x.id !== a.id));
    commit({ ...scene, objects: scene.objects.filter((o) => o.assetId !== a.id) });
    if (projectId) api('DELETE', `/api/projects/${projectId}/assets/${a.id}`).catch(() => setNotice('The image was removed here but could not be deleted from your account. Try again later.'));
  };

  // ---- layers ------------------------------------------------------------
  // Homepage creation links start with the same prepared bird as the editor sample buttons.
  useEffect(() => {
    if (restoring || !autoBird || starterLoaded.current || scene.objects.length || assets.length) return;
    starterLoaded.current = true;
    void useBirdFlight();
  }, [restoring, autoBird]); // eslint-disable-line react-hooks/exhaustive-deps

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
    for (let i = 1; i < p.length - 1; i++) {
      if (p[i + 1].progress - p[i].progress > p[gap + 1].progress - p[gap].progress) gap = i;
    }
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
    if (edit && !isSubjectAction(text)) {
      if (edit.scene !== scene) commit(edit.scene);
      say('ai', edit.message);
      if (edit.action) await runTool('image-gen', { prompt: edit.action.prompt, behind: edit.action.behind });
      return;
    }
    if (!sel) {
      say('ai', 'Upload an image or use the sample bird first, then describe how it should move.');
      return;
    }
    if (requiresActionFrames(text)) {
      if (sel.kind !== 'image') {
        say('ai', 'Select an uploaded or generated image layer to animate its subject.');
        return;
      }
      const actionMode = chooseActionMode();
      if (!projectId || !actionMode) {
        say('ai', !projectId
          ? 'Realistic actions need an online project and Replicate image-to-video. Open a saved project to generate the action. This local editor can adjust positions, but it cannot generate new poses.'
          : 'Connect Replicate in Settings or enable a video generation mode to generate this action. Your image has been kept intact; no simulated action was applied.');
        return;
      }
      await runPaid(text, sel, actionMode);
      return;
    }
    const problem = modeProblem(mode);
    if (problem) {
      say('ai', problem);
      return;
    }
    // Server jobs are used for the paid modes, and for "free" when the server has an AI that understands prompts.
    const serverFree = serverModes.find((m) => m.mode === 'free');
    if (projectId && (mode !== 'free' || (serverFree && serverFree.provider !== 'local-rules'))) {
      await runPaid(text, sel);
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

  // ---- paid generation (server jobs) ------------------------------------------
  const applyServerResult = async (job: ServerJob, target: SceneObject) => {
    const plan = job.result?.plan;
    const videoUrl = job.result?.videoUrl;
    if (videoUrl) {
      setJob({ stage: 'Processing frames' });
      const frames = await extractFrames(videoUrl, 96, 512, chroma.current?.key ?? 'auto');
      setMotionReview({
        generatedAssetId: `motion-${crypto.randomUUID().slice(0, 8)}`,
        targetId: target.id,
        assetId: target.assetId,
        frames,
        patch: { ...plan?.patch, flapsPerScroll: 0, motion: plan?.patch.motion ?? { playback: 'once', cycles: 1 } },
        scrollLength: plan?.scrollLength,
        prompt: activeMotionPrompt.current,
      });
      stop();
      scrub(0);
      return;
    }
    if (plan) {
      const cur = sceneRef.current;
      const patch = { ...plan.patch };
      commit({
        ...cur,
        objects: cur.objects.map((o) => (o.id === target.id ? { ...o, ...patch } : o)),
        scroll: { ...cur.scroll, length: plan.scrollLength ?? cur.scroll.length },
      });
    }
  };

  const acceptMotion = async () => {
    if (!motionReview || !projectId) return;
    try {
      const candidate = motionReview;
      if (!sceneRef.current.objects.some((o) => o.id === candidate.targetId && o.assetId === candidate.assetId)) {
        throw new Error('The source layer changed. Generate motion for the current layer instead.');
      }
      const original = assets.find((a) => a.id === candidate.assetId);
      if (!original) throw new Error('The original image is no longer available.');
      await uploadBinary(`/api/projects/${projectId}/assets/${candidate.generatedAssetId}?name=${encodeURIComponent(`${original.name} action`)}`, await toUploadBlob(original.source));
      await api('PUT', `/api/projects/${projectId}/assets/${candidate.generatedAssetId}/frames`, candidate.frames);
      setAssets((prev) => [...prev.filter((a) => a.id !== candidate.generatedAssetId), { ...original, id: candidate.generatedAssetId, name: `${original.name} action`, frames: candidate.frames, sequence: undefined }]);
      const cur = sceneRef.current;
      commit({ ...cur, objects: cur.objects.map((o) => o.id === candidate.targetId ? { ...o, ...candidate.patch, assetId: candidate.generatedAssetId } : o), scroll: { ...cur.scroll, length: candidate.scrollLength ?? cur.scroll.length } });
      setMotionReview(null);
      say('ai', 'Accepted the reviewed action sequence. It is ready to edit and export.');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'The action could not be saved.');
    }
  };

  const pollJob = async (jobId: string, target: SceneObject): Promise<void> => {
    const deadline = Date.now() + 20 * 60_000;
    while (!aborted.current && Date.now() < deadline) {
      const { job } = await api<{ job: ServerJob }>('GET', `/api/jobs/${jobId}`);
      if (job.status === 'failed') {
        setJob({
          stage: 'Failed',
          error: job.error ?? 'The generation failed.',
          retry: async () => {
            try {
              await api('POST', `/api/jobs/${jobId}/retry`, {});
              setJob({ stage: 'Analysing prompt' });
              await pollJob(jobId, target);
            } catch (e) {
              setJob({ stage: 'Failed', error: e instanceof Error ? e.message : 'Retry failed.' });
            }
          },
        });
        return;
      }
      if (job.status === 'complete') {
        try {
          await applyServerResult(job, target);
          setJob({ stage: 'Complete' });
          say('ai', job.result?.videoUrl ? 'Action generated. Play it forwards and backwards, then accept it only if the movement looks right. You can regenerate or keep the original.' : job.result?.plan?.summary ?? 'Generation finished.');
          setTimeout(() => setJob((j) => (j?.stage === 'Complete' ? null : j)), 1200);
        } catch (e) {
          setJob({ stage: 'Failed', error: e instanceof Error ? e.message : 'Could not use the generated result.' });
        }
        const me = await api<{ credits: number }>('GET', '/api/me').catch(() => null);
        if (me) session.setCredits(me.credits);
        if (chroma.current) {
          api('DELETE', `/api/projects/${projectId}/assets/${chroma.current.id}`).catch(() => undefined);
          chroma.current = null;
        }
        return;
      }
      if (job.status === 'cancelled') return setJob(null);
      setJob({ stage: (STAGES.includes(job.stage as Stage) ? job.stage : 'Generating motion') as Stage });
      await wait(2500);
    }
  };

  const chooseActionMode = (): GenerationMode | null => {
    const candidates = [mode, 'professional', 'fast', 'byok'] as GenerationMode[];
    return candidates.find((m) => serverModes.some((s) => s.mode === m && s.available && (s.generatesMotion || s.provider?.startsWith('replicate:')))) ?? null;
  };

  const runPaid = async (text: string, target: SceneObject | null, requestedMode = mode, sourceOverride?: string) => {
    if (!target) {
      say('ai', 'Add an image first, then describe how it should move.');
      return;
    }
    const requested = serverModes.find((m) => m.mode === requestedMode);
    if (!requested?.available) {
      say('ai', 'That mode is not available on this server yet.');
      return;
    }
    const keyProvider = requestedMode === 'byok' ? 'replicate' : undefined;
    const cost = requested.cost === 0 ? 'no credits (you pay the provider directly)' : `${requested.cost} credits (you have ${session.credits})`;
    if (!window.confirm(`This will use ${cost} with ${requested.provider}. Continue?`)) return;
    activeMotionPrompt.current = text;
    setMotionReview(null);
    try {
      // Video models cannot make transparent video, so the subject is filmed on a flat colour screen
      // and that colour is keyed out of every frame afterwards. Planning-only jobs need none of that.
      let prompt = text;
      let jobAsset: string | undefined;
      const videoGeneration = requested.generatesMotion || requested.provider?.startsWith('replicate:');
      if (videoGeneration) {
        setJob({ stage: 'Preparing image' });
        const source = sourceOverride ?? assets.find((a) => a.id === target.assetId)?.source;
        if (!source) throw new Error('That layer has no image to animate.');
        const screen = await chromaScreenBlob(source);
        const screenId = `gs-${target.assetId}`.slice(0, 40);
        await uploadBinary(`/api/projects/${projectId}/assets/${screenId}?name=chroma-screen.png`, screen.blob);
        chroma.current = { id: screenId, key: screen.key };
        prompt = `${text}. The subject stays centred on a flat, bright ${screen.key} background with a static camera.`;
        jobAsset = screenId;
      }
      setJob({ stage: 'Analysing prompt' });
      const created = await api<{ job: ServerJob; credits: number }>('POST', '/api/jobs', {
        projectId,
        mode: requestedMode,
        realistic: Boolean(videoGeneration),
        prompt,
        idempotencyKey: crypto.randomUUID(),
        assetId: jobAsset,
        keyProvider,
      });
      session.setCredits(created.credits);
      await pollJob(created.job.id, target);
    } catch (e) {
      setJob({ stage: 'Failed', error: e instanceof Error ? e.message : 'Could not start the generation.' });
    }
  };

  // ---- effects, image generation and upscaling --------------------------------
  const addEffect = (type: EffectType) => {
    if (scene.objects.length >= 20) {
      setNotice('A scene can have up to 20 layers.');
      return;
    }
    const follows = type !== 'snow' && sel ? sel.id : null;
    const fx = newEffect(`${type}-${Math.random().toString(36).slice(2, 6)}`, type, follows);
    commit({ ...scene, objects: [...scene.objects, fx] });
    setSelectedId(fx.id);
    setRightTab('layer');
    say('ai', `Added ${EFFECT_LABELS[type].toLowerCase()}.${follows ? ' It follows the selected layer.' : ''}`);
  };

  const addShape = () => {
    if (scene.objects.length >= 20) return setNotice('A scene can have up to 20 layers.');
    const s = newShape(`shape-${Math.random().toString(36).slice(2, 6)}`, shapeType);
    commit({ ...scene, objects: [...scene.objects, s] });
    setSelectedId(s.id);
    setRightTab('layer');
  };

  const addLine = () => {
    if (scene.objects.length >= 20) return setNotice('A scene can have up to 20 layers.');
    const l = newLine(`line-${Math.random().toString(36).slice(2, 6)}`, sel && sel.kind !== 'line' ? sel.id : null);
    commit({ ...scene, objects: [...scene.objects, l] });
    setSelectedId(l.id);
    setRightTab('layer');
    say('ai', l.attachTo ? 'Added a line that draws the selected layer\'s path as you scroll.' : 'Added a line. Drag its handles to shape it.');
  };

  const addGenerated = async (assetId: string, kind: 'image-gen' | 'upscale', opts: { assetId?: string; behind?: boolean }) => {
    const hd = kind === 'upscale';
    const blob = await (await fetch(`/api/projects/${projectId}/assets/${assetId}`, { credentials: 'same-origin' })).blob();
    const source = await readFileAsDataUrl(new File([blob], assetId, { type: blob.type }));
    const built = await buildAsset(source, (s) => setJob({ stage: s }), hd ? 1024 : 512);
    const from = assets.find((a) => a.id === opts.assetId);
    setAssets((prev) => [...prev, { id: assetId, name: hd ? `${(from?.name ?? 'image').replace(/\.[^.]+$/, '')}-hd` : assetId, source, frames: built.frames, hd }]);
    const cur = sceneRef.current;
    if (hd && opts.assetId) {
      // Layers that used the original now use the sharper copy.
      commit({ ...cur, objects: cur.objects.map((o) => (o.assetId === opts.assetId ? { ...o, assetId } : o)) });
      return;
    }
    const layer: SceneObject = {
      ...newObject(assetId, assetId, 'Generated image'),
      widthPct: opts.behind ? 45 : 22,
      parallax: opts.behind ? 0.6 : 0,
      path: [
        { progress: 0, x: 50, y: opts.behind ? 25 : 50 },
        { progress: 1, x: 50, y: opts.behind ? 25 : 50 },
      ],
    };
    commit({ ...cur, objects: opts.behind ? [layer, ...cur.objects] : [...cur.objects, layer] });
    setSelectedId(layer.id);
    return { layer, source };
  };

  const pollTool = async (jobId: string, kind: 'image-gen' | 'upscale', opts: { assetId?: string; behind?: boolean; prompt?: string }): Promise<void> => {
    const deadline = Date.now() + 20 * 60_000;
    while (!aborted.current && Date.now() < deadline) {
      const { job } = await api<{ job: ServerJob }>('GET', `/api/jobs/${jobId}`);
      if (job.status === 'failed') {
        setJob({
          stage: 'Failed',
          error: job.error ?? 'The job failed.',
          retry: async () => {
            try {
              await api('POST', `/api/jobs/${jobId}/retry`, {});
              setJob({ stage: kind === 'image-gen' ? 'Generating image' : 'Upscaling' });
              await pollTool(jobId, kind, opts);
            } catch (e) {
              setJob({ stage: 'Failed', error: e instanceof Error ? e.message : 'Retry failed.' });
            }
          },
        });
        return;
      }
      if (job.status === 'complete') {
        try {
          if (!job.result?.assetId) throw new Error('The provider did not return an image.');
          const generated = await addGenerated(job.result.assetId, kind, opts);
          setJob({ stage: 'Complete' });
          say('ai', kind === 'image-gen' ? 'Your image is ready and has been added as a layer.' : 'Upscaled. Your layers now use the sharper image.');
          if (kind === 'image-gen' && generated && opts.prompt && isSubjectAction(opts.prompt)) {
            const actionMode = chooseActionMode();
            if (actionMode) await runPaid(opts.prompt, generated.layer, actionMode, generated.source);
            else say('ai', 'The image is ready. Connect Replicate to generate its requested action; the still image has not been animated.');
          }
          setTimeout(() => setJob((j) => (j?.stage === 'Complete' ? null : j)), 1200);
        } catch (e) {
          setJob({ stage: 'Failed', error: e instanceof Error ? e.message : 'Could not use the result.' });
        }
        const me = await api<{ credits: number }>('GET', '/api/me').catch(() => null);
        if (me) session.setCredits(me.credits);
        return;
      }
      if (job.status === 'cancelled') return setJob(null);
      setJob({ stage: kind === 'image-gen' ? 'Generating image' : 'Upscaling' });
      await wait(2500);
    }
  };

  const runTool = async (kind: 'image-gen' | 'upscale', opts: { prompt?: string; assetId?: string; scale?: 2 | 4; behind?: boolean }) => {
    const tool = serverTools.find((t) => t.kind === kind);
    if (!projectId || !tool?.available) {
      say('ai', 'That needs an image provider, which this server has not set up. You can still upload your own image.');
      return;
    }
    const ownKey = payWithKey || !tool.platformKey;
    const price = ownKey ? `no credits (it uses your own ${tool.keyProvider} key)` : `${tool.cost} credits (you have ${session.credits})`;
    if (!window.confirm(`${kind === 'image-gen' ? 'Generate an image' : 'Upscale this image'}: this will use ${price} with ${tool.provider}. Continue?`)) return;
    try {
      setJob({ stage: kind === 'image-gen' ? 'Generating image' : 'Upscaling' });
      const created = await api<{ job: ServerJob; credits: number }>('POST', '/api/jobs', {
        projectId,
        kind,
        prompt: opts.prompt ?? 'upscale',
        assetId: opts.assetId,
        scale: opts.scale,
        useOwnKey: ownKey,
        keyProvider: ownKey ? tool.keyProvider : undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      session.setCredits(created.credits);
      await pollTool(created.job.id, kind, opts);
    } catch (e) {
      setJob({ stage: 'Failed', error: e instanceof Error ? e.message : 'Could not start that.' });
    }
  };

  /** Why a generation mode cannot be used right now, in plain words (null when it can). */
  function modeProblem(m: GenerationMode): string | null {
    if (m === 'free') return null;
    if (!projectId) {
      return session.user
        ? 'Fast, Professional and your own key work inside a saved project. Open one from Projects (or create a new one), then pick this mode again.'
        : 'Sign in and open a saved project to use Fast, Professional or your own key.';
    }
    if (serverModes.length === 0) return 'Could not check what this server supports. Refresh the page and try again.';
    if (serverModes.find((s) => s.mode === m)?.available) return null;
    if ((m === 'fast' || m === 'professional') && setup && !setup.replicateToken) {
      return `${m === 'fast' ? 'Fast' : 'Professional'} is not set up yet: the server cannot see REPLICATE_API_TOKEN. In Cloudflare it must be a Secret in the Worker's own Settings → Variables and Secrets (not the Build settings), followed by a redeploy. See Settings in this app for a setup checklist.`;
    }
    if (m === 'fast') return 'Fast is not set up on this server yet. The person who runs it needs to add REPLICATE_API_TOKEN.';
    if (m === 'professional') return 'Professional is not set up yet: the server has a Replicate token but no video model chosen. Add a variable REPLICATE_PRO_MODEL, for example bytedance/seedance-1-pro.';
    return 'This mode is not available on this server.';
  }

  const hasObjects = scene.objects.length > 0;

  // ---- export view -------------------------------------------------------
  if (view === 'export') {
    return (
      <ExportView
        scene={scene}
        assets={framesMap}
        projectId={projectId}
        onBack={() => setView('edit')}
      />
    );
  }

  return (
    <div className="editor">
      <header className="ed-top">
        <a className="brand" href="#/">MotionForge <span>AI</span></a>
        <div className="ed-top-group">
          {projectId && <a className="btn ghost" href="#/dashboard">← Projects</a>}
          <label className="inline">
            <span className="sr-only">Generation mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as GenerationMode)} aria-label="Generation mode">
              {Object.values(PROVIDER_SETS).map((p) => (
                <option key={p.mode} value={p.mode}>
                  {p.label}{modeProblem(p.mode) ? ' (see note below)' : ''}
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
          {projectId && <span className="muted" title="Credits available">{session.credits} credits</span>}
          {projectId && <button type="button" className="btn ghost" onClick={() => setShowShare(true)} disabled={readOnly}>Share</button>}
          <button type="button" className="btn ghost" onClick={history.undo} disabled={!history.canUndo}>Undo</button>
          <button type="button" className="btn ghost" onClick={history.redo} disabled={!history.canRedo}>Redo</button>
          <span className={`save save-${saveState}`} role="status">
            {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Could not save (storage full)'}
          </span>
          <button type="button" className="btn primary" onClick={() => setView('export')} disabled={!hasObjects || Boolean(motionReview)}>
            Export
          </button>
        </div>
      </header>

      {notice && (
        <div className="banner" role="alert">
          {notice} <button type="button" className="link" onClick={() => setNotice('')}>Dismiss</button>
        </div>
      )}

      {readOnly && <div className="banner info" role="status">You have view-only access to this project. Ask a team editor if you need to change it.</div>}

      <div className="ed-main">
        <aside className="panel left" aria-label="Assets and layers">
          {/* the tabs sit outside the disabled fieldset so people with view-only access can still look around */}
          <TabBar label="Editing tools" tabs={LEFT_TABS} value={leftTab} onChange={setLeftTab} />
          <fieldset disabled={readOnly} className="plain">
          <div role="tabpanel" aria-label={LEFT_TABS.find((t) => t.id === leftTab)?.label}>
          {leftTab === 'media' && (<>
          <h2>Images</h2>
          <div className="row">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>Upload image</button>
            <button type="button" className="btn ghost" onClick={useSample}>Use sample bird</button>
            <button type="button" className="btn ghost" onClick={() => void useBirdFlight()}>Use robin flight sequence</button>
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
                {serverTools.find((t) => t.kind === 'upscale')?.available && (
                  <button type="button" className="btn small ghost" onClick={() => void runTool('upscale', { assetId: a.id, scale: 2 })} aria-label={`Upscale ${a.name} to higher resolution`}>Upscale</button>
                )}
                <button type="button" className="btn small ghost" onClick={() => { replaceTarget.current = a.id; replaceRef.current?.click(); }} aria-label={`Replace ${a.name}`}>Replace</button>
                <button type="button" className="btn small ghost danger" onClick={() => deleteAsset(a)} aria-label={`Delete ${a.name}`}>Delete</button>
              </li>
            ))}
          </ul>

          </>)}
          {leftTab === 'add' && (<>
          <h2>Effects</h2>
          <div className="row">
            <label className="sr-only" htmlFor="fx-type">Effect type</label>
            <select id="fx-type" value={fxType} onChange={(e) => setFxType(e.target.value as EffectType)}>
              {EFFECT_TYPES.map((t) => <option key={t} value={t}>{EFFECT_LABELS[t]}</option>)}
            </select>
            <button type="button" className="btn small" onClick={() => addEffect(fxType)}>Add effect</button>
          </div>
          <p className="muted small-note">Smoke, fire, water and sparkles follow the selected layer. Snow falls across the whole scene.</p>

          <h2>Shapes and lines</h2>
          <div className="row">
            <label className="sr-only" htmlFor="shape-type">Shape</label>
            <select id="shape-type" value={shapeType} onChange={(e) => setShapeType(e.target.value as ShapeSettings['type'])}>
              <option value="circle">Circle</option>
              <option value="rect">Rectangle</option>
            </select>
            <button type="button" className="btn small" onClick={addShape}>Add shape</button>
            <button type="button" className="btn small" onClick={addLine}>{sel && sel.kind !== 'line' ? 'Trace path' : 'Add line'}</button>
          </div>
          <p className="muted small-note">Shapes are simple HTML elements. “Trace path” draws the selected layer's route as a line that fills in as you scroll.</p>

          </>)}
          {leftTab === 'media' && projectId && (
            <>
              <h2>Create with AI</h2>
              {serverTools.find((t) => t.kind === 'image-gen')?.available ? (
                <>
                  <label className="field"><span>Describe an image</span>
                    <input type="text" value={aiPrompt} maxLength={200} onChange={(e) => setAiPrompt(e.target.value)} placeholder="a red hot air balloon" />
                  </label>
                  {(() => {
                    const t = serverTools.find((x) => x.kind === 'image-gen')!;
                    return (
                      <>
                        <div className="row">
                          <button type="button" className="btn small primary" disabled={!aiPrompt.trim()} onClick={() => void runTool('image-gen', { prompt: aiPrompt })}>
                            Generate image · {payWithKey || !t.platformKey ? 'your key' : `${t.cost} credits`}
                          </button>
                        </div>
                        {t.platformKey && t.keyProvider && (
                          <label className="check"><input type="checkbox" checked={payWithKey} onChange={(e) => setPayWithKey(e.target.checked)} /> Use my own {t.keyProvider} key instead of credits</label>
                        )}
                      </>
                    );
                  })()}
                </>
              ) : (
                <p className="muted small-note">Image generation is not set up on this server.</p>
              )}
            </>
          )}

          {leftTab === 'layers' && (<>
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
          </>)}
          </div>
          </fieldset>
        </aside>

        <main className="center" aria-label="Live preview">
          {hasObjects ? (
            <div className="frame" style={{ width: DEVICE_WIDTH[device] }}>
              <iframe
                ref={iframeRef}
                title="Scroll animation preview"
                sandbox="allow-scripts"
                srcDoc={previewHtml}
                onLoad={() => post({ type: 'mf-scene', scene: previewSceneRef.current })}
              />
              {sel && !sel.pinned && !sel.attachTo && (
                <PathOverlay obj={sel} selected={pointIdx} onSelect={(i) => { setPointIdx(i); setRightTab('path'); }} onChange={setPath} />
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
          <TabBar label="Property sections" tabs={RIGHT_TABS} value={rightTab} onChange={setRightTab} />
          <fieldset disabled={readOnly} className="plain">
          <div role="tabpanel" aria-label={RIGHT_TABS.find((t) => t.id === rightTab)?.label}>
          {!sel && rightTab !== 'scroll' && <p className="muted">Select a layer to edit it.</p>}
          {sel && (
            <>
              {rightTab === 'layer' && (<>
              <label className="field">
                <span>Name</span>
                <input type="text" maxLength={60} value={sel.name} onChange={(e) => patchSel({ name: e.target.value || 'Layer' }, 'name')} />
              </label>
              {sel.effect && <EffectControls effect={sel.effect} onChange={(p) => patchSel({ effect: { ...sel.effect!, ...p } }, `fx-${Object.keys(p)[0]}`)} />}
              {sel.shape && <ShapeControls shape={sel.shape} onChange={(p) => patchSel({ shape: { ...sel.shape!, ...p } }, `shape-${Object.keys(p)[0]}`)} />}
              {sel.line && <LineControls line={sel.line} onChange={(p) => patchSel({ line: { ...sel.line!, ...p } }, `line-${Object.keys(p)[0]}`)} />}
              {sel.kind === 'image' && <Slider label="Size (% of width)" min={2} max={100} step={1} value={sel.widthPct} onChange={(v) => patchSel({ widthPct: v })} />}
              <Slider label="Mobile size multiplier" min={0.2} max={2} step={0.05} value={sel.mobileScale} onChange={(v) => patchSel({ mobileScale: v })} />
              {sel.kind === 'image' && (sel.motion ? <>
                <label className="field"><span>Action playback</span>
                  <select value={sel.motion.playback} onChange={(e) => patchSel({ motion: { ...sel.motion!, playback: e.target.value as 'once' | 'loop', cycles: 1 } })}>
                    <option value="once">Play the action once</option>
                    <option value="loop">Repeat the action</option>
                  </select>
                </label>
                {sel.motion.playback === 'loop' && <Slider label="Action repeats per scroll" min={0.1} max={20} step={0.1} value={sel.motion.cycles} onChange={(v) => patchSel({ motion: { ...sel.motion!, cycles: v } })} />}
              </> : <Slider label="Wing flaps per scroll" min={0} max={60} step={1} value={sel.flapsPerScroll} onChange={(v) => patchSel({ flapsPerScroll: v })} />)}
              <Slider label="Body rise & fall" min={0} max={10} step={0.1} value={sel.bob} onChange={(v) => patchSel({ bob: v })} />
              </>)}
              {rightTab === 'look' && (<>
              <Triple label="Rotation (°)" min={-180} max={180} step={1} values={three(sel.rotation)} onChange={(v) => patchSel({ rotation: v }, 'rotation')} />
              <Triple label="Scale" min={0.1} max={3} step={0.05} values={three(sel.scale)} onChange={(v) => patchSel({ scale: v }, 'scale')} />
              <Triple label="Opacity" min={0} max={1} step={0.05} values={three(sel.opacity)} onChange={(v) => patchSel({ opacity: v }, 'opacity')} />
              <Triple label="Blur (px)" min={0} max={20} step={0.5} values={three(sel.blur)} onChange={(v) => patchSel({ blur: v }, 'blur')} />
              </>)}
              {rightTab === 'timing' && (<>
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
              <Slider label="Parallax (depth drift)" min={-2} max={2} step={0.1} value={sel.parallax} onChange={(v) => patchSel({ parallax: v })} />
              <label className="field">
                <span>Follow another layer</span>
                <select value={sel.attachTo ?? ''} onChange={(e) => patchSel({ attachTo: e.target.value || null })}>
                  <option value="">No, use its own path</option>
                  {scene.objects.filter((o) => o.id !== sel.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
              {sel.attachTo && (
                <>
                  <Slider label="Offset X (% of width)" min={-60} max={60} step={0.5} value={sel.offsetX} onChange={(v) => patchSel({ offsetX: v })} />
                  <Slider label="Offset Y (% of height)" min={-60} max={60} step={0.5} value={sel.offsetY} onChange={(v) => patchSel({ offsetY: v })} />
                </>
              )}

              </>)}
              {rightTab === 'path' && (<>
              <h3>Motion path</h3>
              <label className="field">
                <span>Flight direction</span>
                <select value={Object.keys(FLIGHT_ROUTES).find((key) => JSON.stringify(FLIGHT_ROUTES[key]) === JSON.stringify(sel.path)) ?? ''} onChange={(e) => {
                  const path = FLIGHT_ROUTES[e.target.value];
                  if (!path) return;
                  stop();
                  patchSel({ path, pinned: false, attachTo: null }, 'flight-direction');
                  setPointIdx(0);
                  scrub(0);
                }}>
                  <option value="">Choose a direction…</option>
                  <option value="right">Fly right</option>
                  <option value="left">Fly left</option>
                  <option value="up">Fly up</option>
                  <option value="down">Fly down</option>
                  <option value="return">Fly up and return</option>
                </select>
              </label>
              <div className="row">
                <button type="button" className="btn small" onClick={addPoint} disabled={sel.pinned || !!sel.attachTo || sel.path.length >= 24}>Add point</button>
                <button type="button" className="btn small ghost danger" onClick={removePoint} disabled={sel.pinned || !!sel.attachTo || sel.path.length <= 2}>Remove point {pointIdx + 1}</button>
              </div>
              {sel.path[pointIdx] && !sel.pinned && !sel.attachTo && (
                <div className="row">
                  <label className="field half"><span>X %</span>
                    <input type="number" step={1} value={sel.path[pointIdx].x} onChange={(e) => setPath(sel.path.map((k, i) => (i === pointIdx ? { ...k, x: Number(e.target.value) } : k)), `path-${pointIdx}`)} />
                  </label>
                  <label className="field half"><span>Y %</span>
                    <input type="number" step={1} value={sel.path[pointIdx].y} onChange={(e) => setPath(sel.path.map((k, i) => (i === pointIdx ? { ...k, y: Number(e.target.value) } : k)), `path-${pointIdx}`)} />
                  </label>
                </div>
              )}
              </>)}
            </>
          )}

          {rightTab === 'scroll' && (<>
          <h3>Scroll</h3>
          <Slider label="Scroll length (px)" min={300} max={8000} step={50} value={scene.scroll.length} onChange={(v) => commit({ ...scene, scroll: { ...scene.scroll, length: v } }, 'scroll-length')} />
          <Slider label="Smoothing" min={0} max={1} step={0.05} value={scene.scroll.smoothing} onChange={(v) => commit({ ...scene, scroll: { ...scene.scroll, smoothing: v } }, 'smoothing')} />
          <label className="check"><input type="checkbox" checked={scene.scroll.reverse} onChange={(e) => commit({ ...scene, scroll: { ...scene.scroll, reverse: e.target.checked } })} /> Reverse when scrolling up</label>
          </>)}
          </div>
          </fieldset>
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
      {motionReview && <section className="panel" aria-label="Review generated action">
        <h2>Review generated action</h2>
        <p>Check the full movement for correct limbs, natural contact and complete wing or hand tips. This preview has not replaced your original animation.</p>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => void acceptMotion()}>Accept action</button>
          <button type="button" className="btn ghost" onClick={() => {
            const target = scene.objects.find((o) => o.id === motionReview.targetId);
            const actionMode = chooseActionMode();
            if (target && actionMode) void runPaid(motionReview.prompt, target, actionMode);
          }}>Regenerate action</button>
          <button type="button" className="btn ghost" onClick={() => setMotionReview(null)}>Keep original</button>
        </div>
      </section>}
      {showShare && projectId && <ShareDialog projectId={projectId} onClose={() => setShowShare(false)} />}

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
            disabled={readOnly}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Make this bird flap its wings and fly along a curved path from the bottom-left to the top-right"
          />
          <button type="submit" className="btn primary" disabled={readOnly || !prompt.trim() || (job !== null && job.stage !== 'Failed' && job.stage !== 'Complete')}>Send</button>
        </form>
        {modeProblem(mode) && <p className="error small-note" role="status">{modeProblem(mode)}</p>}
        <p className="muted small-note">
          {projectId && mode !== 'free' && modeInfo
            ? `Using ${modeInfo.provider ?? 'no provider'} · estimated cost: ${modeInfo.cost === 0 ? '0 credits (your own key)' : `${modeInfo.cost} credits`}`
            : `Using ${providers.planner.id} · ${providers.backgroundRemover.id} · ${providers.motionFrames.id} · estimated cost: 0 credits`}
        </p>
      </div>
    </div>
  );
}

/** Accessible tab strip: arrow keys, Home and End move between tabs. */
function TabBar<T extends string>({ label, tabs, value, onChange }: { label: string; tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    (e.currentTarget.querySelectorAll('[role=tab]')[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="tabs" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" className="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function EffectControls({ effect, onChange }: { effect: EffectSettings; onChange: (patch: Partial<EffectSettings>) => void }) {
  return (
    <fieldset className="triple">
      <legend>{EFFECT_LABELS[effect.type]} settings</legend>
      <Slider label="Particles" min={10} max={800} step={10} value={effect.count} onChange={(v) => onChange({ count: v })} />
      <Slider label="Particle size" min={2} max={120} step={1} value={effect.size} onChange={(v) => onChange({ size: v })} />
      <Slider label="Spread (% of width)" min={0} max={100} step={1} value={effect.spread} onChange={(v) => onChange({ spread: v })} />
      <Slider label="Travel distance (% of height)" min={0} max={150} step={1} value={effect.rise} onChange={(v) => onChange({ rise: v })} />
      <Slider label="Cycles over the scroll" min={0.5} max={30} step={0.5} value={effect.loops} onChange={(v) => onChange({ loops: v })} />
      <label className="field"><span>Colour</span>
        <input type="color" value={effect.color} onChange={(e) => onChange({ color: e.target.value })} aria-label="Particle colour" />
      </label>
      <label className="field"><span>Drawn</span>
        <select value={effect.layer} onChange={(e) => onChange({ layer: e.target.value as 'back' | 'front' })}>
          <option value="front">In front of images</option>
          <option value="back">Behind images</option>
        </select>
      </label>
      <button type="button" className="btn small ghost" onClick={() => onChange({ seed: Math.floor(Math.random() * 100000) })}>Shuffle pattern</button>
    </fieldset>
  );
}

function ShapeControls({ shape, onChange }: { shape: ShapeSettings; onChange: (patch: Partial<ShapeSettings>) => void }) {
  return (
    <fieldset className="triple">
      <legend>Shape settings</legend>
      <label className="field"><span>Colour</span>
        <input type="color" value={shape.color} onChange={(e) => onChange({ color: e.target.value })} aria-label="Shape colour" />
      </label>
      <Slider label="Width (% of stage)" min={1} max={100} step={1} value={shape.widthPct} onChange={(v) => onChange({ widthPct: v })} />
      <Slider label="Height (% of stage)" min={1} max={100} step={1} value={shape.heightPct} onChange={(v) => onChange({ heightPct: v })} />
      {shape.type === 'rect' && <Slider label="Corner rounding" min={0} max={50} step={1} value={shape.radius} onChange={(v) => onChange({ radius: v })} />}
      <label className="field"><span>Drawn</span>
        <select value={shape.layer} onChange={(e) => onChange({ layer: e.target.value as 'back' | 'front' })}>
          <option value="front">In front of images</option>
          <option value="back">Behind images</option>
        </select>
      </label>
    </fieldset>
  );
}

function LineControls({ line, onChange }: { line: LineSettings; onChange: (patch: Partial<LineSettings>) => void }) {
  return (
    <fieldset className="triple">
      <legend>Line settings</legend>
      <label className="field"><span>Colour</span>
        <input type="color" value={line.color} onChange={(e) => onChange({ color: e.target.value })} aria-label="Line colour" />
      </label>
      <Slider label="Thickness (px)" min={1} max={40} step={1} value={line.width} onChange={(v) => onChange({ width: v })} />
      <label className="field"><span>Reveal</span>
        <select value={line.reveal} onChange={(e) => onChange({ reveal: e.target.value as 'draw' | 'static' })}>
          <option value="draw">Draws in as you scroll</option>
          <option value="static">Always fully drawn</option>
        </select>
      </label>
      {line.reveal === 'static' && <Slider label="Dash length (px, 0 = solid)" min={0} max={50} step={1} value={line.dash} onChange={(v) => onChange({ dash: v })} />}
      <label className="field"><span>Drawn</span>
        <select value={line.layer} onChange={(e) => onChange({ layer: e.target.value as 'back' | 'front' })}>
          <option value="front">In front of images</option>
          <option value="back">Behind images</option>
        </select>
      </label>
    </fieldset>
  );
}

function JobStatus({ job, onClose }: { job: NonNullable<Job>; onClose: () => void }) {
  const list: Stage[] = job.stage === 'Generating image' || job.stage === 'Upscaling' ? ['Preparing image', job.stage, 'Optimising assets', 'Complete'] : STAGES;
  const idx = list.indexOf(job.stage as Stage);
  return (
    <div className="job" role="status" aria-live="polite">
      <ol>
        {list.map((s, i) => (
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

function ShareDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [links, setLinks] = useState<{ token: string; createdAt: number }[] | null>(null);
  const [msg, setMsg] = useState('');
  const urlFor = (token: string) => `${window.location.origin}${window.location.pathname}#/share/${token}`;

  const load = useCallback(async () => {
    try {
      setLinks((await api<{ shares: { token: string; createdAt: number }[] }>('GET', `/api/projects/${projectId}/shares`)).shares);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not load share links.');
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    try {
      await api('POST', `/api/projects/${projectId}/shares`, {});
      setMsg('Link created. Anyone with it can view (not edit) this animation.');
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not create a link.');
    }
  };
  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(urlFor(token));
      setMsg('Link copied.');
    } catch {
      setMsg(urlFor(token));
    }
  };
  const revoke = async (token: string) => {
    try {
      await api('DELETE', `/api/projects/${projectId}/shares/${token}`);
      setMsg('Link turned off.');
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not turn off that link.');
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Share this animation">
      <div className="modal-card">
        <h2>Share</h2>
        <p className="muted">Share a view-only page. Visitors do not need an account.</p>
        <button type="button" className="btn primary" onClick={() => void create()}>Create a link</button>
        <ul className="list">
          {links?.map((l) => (
            <li key={l.token} className="asset">
              <span className="grow" title={urlFor(l.token)}>Created {when(l.createdAt)}</span>
              <button type="button" className="btn small" onClick={() => void copy(l.token)}>Copy link</button>
              <button type="button" className="btn small ghost danger" onClick={() => void revoke(l.token)}>Turn off</button>
            </li>
          ))}
        </ul>
        {links?.length === 0 && <p className="muted">No links yet.</p>}
        <p role="status" className="muted small-note">{msg}</p>
        <button type="button" className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function ExportView({ scene, assets, projectId, onBack }: { scene: Scene; assets: Record<string, string[]>; projectId?: string; onBack: () => void }) {
  const [msg, setMsg] = useState('');
  const logExport = (format: string) => {
    if (projectId) api('POST', `/api/projects/${projectId}/exports`, { format }).catch(() => undefined);
  };
  const { user } = useSession();
  const plan = user?.plan ?? 'none';
  const paid = plan === 'creator' || plan === 'professional';
  const pro = plan === 'professional';
  const [light, setLight] = useState(false);
  // Free and account-less exports carry a small badge; paid plans do not. Professional can thin the frames.
  const options = useMemo<ExportOptions>(
    () => ({ watermarkUrl: paid ? null : `${window.location.origin}${window.location.pathname}`, frameStep: pro && light ? 2 : 1, commercial: pro }),
    [paid, pro, light],
  );
  const input = useMemo(() => ({ scene, assets }), [scene, assets]);
  const html = useMemo(() => buildStandaloneHtml(input, options), [input, options]);
  const kb = Math.round(html.length / 1024);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildSnippet(input, 'motionforge-1', options));
      logExport('snippet');
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
            <button type="button" className="btn primary" onClick={() => { logExport('html'); download('motionforge-animation.html', html, 'text/html'); }}>Download standalone HTML</button>
            <button type="button" className="btn" onClick={() => void copy()}>Copy embed snippet</button>
            <button type="button" className="btn" onClick={() => { logExport('zip'); download('motionforge-bundle.zip', buildZip(input, options) as unknown as BlobPart, 'application/zip'); }}>Download self-host ZIP</button>
          </div>
          <p role="status" className="muted">{msg || `Standalone file size: about ${kb} KB.`}</p>
          {!paid && <p className="muted small-note">Free exports include a small “Made with MotionForge” badge. Creator and Professional plans remove it and use sharper 1024 px frames.</p>}
          {pro ? (
            <label className="check"><input type="checkbox" checked={light} onChange={(e) => setLight(e.target.checked)} /> Lighter files (use every other frame)</label>
          ) : (
            <p className="muted small-note">Advanced export options (lighter files, commercial licence) are part of the Professional plan.</p>
          )}

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
