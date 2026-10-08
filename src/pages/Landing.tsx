import { useEffect, useRef, useState } from 'react';
import { buildAsset } from '../ai/imagePipeline';
import { planFromPrompt } from '../ai/localPlanner';
import { emptyScene, newObject } from '../scene/defaults';
import { parseScene } from '../scene/schema';

const DEMO_PROMPT = 'Make this bird flap its wings and fly along a curved path from the bottom-left to the top-right as the user scrolls.';

function BirdDemo() {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    let controller: { destroy(): void } | null = null;
    (async () => {
      try {
        const blob = await (await fetch(`${import.meta.env.BASE_URL}sample-bird.svg`)).blob();
        const data = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(new Error('read failed'));
          fr.readAsDataURL(blob);
        });
        const built = await buildAsset(data, () => undefined);
        const plan = planFromPrompt(DEMO_PROMPT);
        const parsed = parseScene({
          ...emptyScene(),
          objects: [{ ...newObject('bird', 'bird', 'Bird'), ...plan.patch, widthPct: 24 }],
          scroll: { ...emptyScene().scroll, length: 1400 },
        });
        if (cancelled || !host.current || !parsed.ok) return;
        controller = window.MotionForge.mount(host.current, { scene: parsed.scene, assets: { bird: built.frames } }, { stageHeight: '80vh' });
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      controller?.destroy();
    };
  }, []);

  return (
    <section className="demo" aria-label="Interactive bird demonstration">
      <div className="demo-note">
        {state === 'loading' && 'Preparing the demo…'}
        {state === 'ready' && 'Keep scrolling: the bird follows your scroll. Scroll back up and it flies in reverse.'}
        {state === 'error' && 'The demo could not load in this browser.'}
      </div>
      <div ref={host} />
    </section>
  );
}

const GALLERY = [
  ['Bird in flight', DEMO_PROMPT],
  ['Product reveal', 'Make this product rotate slowly and grow larger as the visitor scrolls.'],
  ['Drifting balloon', 'Make this balloon float from the bottom to the top, gently swaying.'],
  ['Cinematic sweep', 'Make this object move from the left to the right in a cinematic way.'],
];

const FAQ = [
  ['Do I need to code?', 'No. Upload an image, describe the motion, adjust it visually, and copy the result into your site.'],
  ['Does the export need MotionForge to keep working?', 'No. Exports are plain HTML, CSS and JavaScript with the frames included. They contain no account details or API keys.'],
  ['What does the free mode do?', 'It removes plain backgrounds in your browser and animates with paths, scale, rotation, opacity and a simulated wing flap. Nothing is uploaded anywhere.'],
  ['When do Fast, Professional and bring-your-own-key arrive?', 'They need a server for accounts, encrypted keys and a job queue. The provider-adapter layer is already in place for them; the server is the next step.'],
  ['Is it accessible?', 'Exports respect the “reduce motion” setting and show a still frame instead.'],
];

export function Landing() {
  return (
    <div className="landing">
      <header className="nav">
        <a className="brand" href="#/">MotionForge <span>AI</span></a>
        <nav aria-label="Main">
          <a href="#/docs">Docs</a>
          <a className="btn primary" href="#/editor">Open editor</a>
        </nav>
      </header>

      <section className="hero">
        <h1>Turn any image into an interactive scroll animation.</h1>
        <p>Upload an image, describe how it should move, and export production-ready code for any website.</p>
        <a className="btn primary big" href="#/editor">Create your first animation</a>
      </section>

      <BirdDemo />

      <section className="section" aria-labelledby="steps">
        <h2 id="steps">Three steps</h2>
        <ol className="cards">
          <li><b>1. Upload</b><span>Add a PNG, JPG or WebP. Plain backgrounds are removed for you.</span></li>
          <li><b>2. Describe</b><span>Write how it should move, then fine-tune the path, speed and size.</span></li>
          <li><b>3. Export</b><span>Copy an embed snippet or download standalone code with no strings attached.</span></li>
        </ol>
      </section>

      <section className="section" aria-labelledby="gallery">
        <h2 id="gallery">Try an idea</h2>
        <ul className="cards">
          {GALLERY.map(([title, prompt]) => (
            <li key={title}>
              <b>{title}</b>
              <span>“{prompt}”</span>
              <a href={`#/editor?prompt=${encodeURIComponent(prompt)}`}>Use this prompt</a>
            </li>
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="formats">
        <h2 id="formats">Export formats</h2>
        <ul className="pills">
          <li>Embed snippet</li>
          <li>Standalone HTML</li>
          <li>Self-host ZIP</li>
          <li>React component</li>
          <li>Webflow embed</li>
          <li>WordPress block</li>
        </ul>
      </section>

      <section className="section" aria-labelledby="compare">
        <h2 id="compare">Free and professional generation</h2>
        <table>
          <thead>
            <tr><th scope="col" /><th scope="col">Free (available now)</th><th scope="col">Professional (needs server)</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">Background removal</th><td>Plain backgrounds, in your browser</td><td>AI cut-out of complex scenes</td></tr>
            <tr><th scope="row">Movement</th><td>Path, scale, rotation, opacity, simulated wing flap</td><td>Image-to-video frames</td></tr>
            <tr><th scope="row">Resolution</th><td>Up to 512 px, 24 frames</td><td>Higher resolution and frame count</td></tr>
          </tbody>
        </table>
      </section>

      <section className="section" aria-labelledby="pricing">
        <h2 id="pricing">Pricing</h2>
        <p className="muted">Billing is not live yet. The editor and exports are free to use today.</p>
        <ul className="cards">
          <li><b>Free</b><span>Basic motion tools, standard export, lower-resolution generations.</span></li>
          <li><b>Creator</b><span>More credits, premium models, higher-resolution export, no watermark. Coming soon.</span></li>
          <li><b>Professional</b><span>Largest allowance, commercial use, team projects, priority processing. Coming soon.</span></li>
        </ul>
      </section>

      <section className="section" aria-labelledby="faq">
        <h2 id="faq">Questions</h2>
        {FAQ.map(([q, a]) => (
          <details key={q}><summary>{q}</summary><p>{a}</p></details>
        ))}
      </section>

      <section className="hero end">
        <h2>Make something that moves with your visitors.</h2>
        <a className="btn primary big" href="#/editor">Create your first animation</a>
      </section>
    </div>
  );
}
