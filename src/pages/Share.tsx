import { useEffect, useRef, useState } from 'react';
import { buildAsset } from '../ai/imagePipeline';
import { readFileAsDataUrl } from '../ai/imagePipeline';
import { parseScene } from '../scene/schema';

interface SharedView {
  name: string;
  scene: unknown;
  assets: { id: string; hasFrames: boolean }[];
}

/** Public, read-only page for a shared project. No account needed. */
export function Share({ token }: { token: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [name, setName] = useState('');

  useEffect(() => {
    let cancelled = false;
    let controller: { destroy(): void } | null = null;
    (async () => {
      try {
        const res = await fetch(`/api/share/${token}`);
        if (res.status === 404) return void (!cancelled && setState('missing'));
        if (!res.ok) throw new Error('load failed');
        const view = (await res.json()) as SharedView;
        const parsed = parseScene(view.scene);
        if (!parsed.ok) throw new Error('invalid scene');
        const assets: Record<string, string[]> = {};
        for (const a of view.assets) {
          if (a.hasFrames) {
            const fr = await fetch(`/api/share/${token}/assets/${a.id}/frames`);
            if (fr.ok) {
              assets[a.id] = (await fr.json()) as string[];
              continue;
            }
          }
          const img = await fetch(`/api/share/${token}/assets/${a.id}`);
          if (!img.ok) continue;
          const blob = await img.blob();
          const source = await readFileAsDataUrl(new File([blob], a.id, { type: blob.type }));
          assets[a.id] = (await buildAsset(source, () => undefined)).frames;
        }
        if (cancelled || !host.current) return;
        controller = window.MotionForge.mount(host.current, { scene: parsed.scene, assets });
        setName(view.name);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      controller?.destroy();
    };
  }, [token]);

  return (
    <div className="share">
      <header className="nav share-bar">
        <span className="muted">{state === 'ready' ? `${name} · scroll to play` : ''}</span>
        <a className="brand" href="#/">Made with MotionForge <span>AI</span></a>
      </header>
      {state === 'loading' && <p className="muted center-text">Loading…</p>}
      {state === 'missing' && <p className="center-text">This link is no longer available.</p>}
      {state === 'error' && <p className="center-text">This animation could not be loaded.</p>}
      <div ref={host} />
    </div>
  );
}
