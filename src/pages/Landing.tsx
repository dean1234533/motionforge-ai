import { useEffect, useRef, useState } from 'react';
import { buildAsset } from '../ai/imagePipeline';
import { planFromPrompt } from '../ai/localPlanner';
import { emptyScene, newObject } from '../scene/defaults';
import { useSession } from '../lib/session';
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

type ArtKind = 'bird' | 'product' | 'balloon' | 'sweep' | 'rocket' | 'snow';

const GALLERY: [string, string, ArtKind][] = [
  ['Bird in flight', DEMO_PROMPT, 'bird'],
  ['Product reveal', 'Make this product rotate slowly and grow larger as the visitor scrolls.', 'product'],
  ['Drifting balloon', 'Make this balloon float from the bottom to the top, gently swaying.', 'balloon'],
  ['Cinematic sweep', 'Make this object move from the left to the right in a cinematic way.', 'sweep'],
  ['Rocket launch', 'Make this rocket fly from the bottom to the top. Add fire behind it.', 'rocket'],
  ['Falling snow', 'Add snow to the scene and make it feel cinematic.', 'snow'],
];

/** Small looping previews of each idea, drawn with SVG and CSS so they cost nothing to load. */
function Art({ kind }: { kind: ArtKind }) {
  return (
    <svg className={`art art-${kind}`} viewBox="0 0 160 90" role="img" aria-label={`${kind} animation preview`}>
      <rect width="160" height="90" rx="8" className="art-bg" />
      {kind === 'bird' && (
        <g className="a-fly"><path className="a-wing a-wing-l" d="M80 46 C62 30 40 28 26 34 C42 38 52 44 56 52 Z" /><path className="a-wing a-wing-r" d="M80 46 C98 30 120 28 134 34 C118 38 108 44 104 52 Z" /><ellipse cx="80" cy="52" rx="7" ry="14" className="a-body" /></g>
      )}
      {kind === 'product' && <rect className="a-spin" x="60" y="25" width="40" height="40" rx="6" />}
      {kind === 'balloon' && (
        <g className="a-float"><ellipse cx="80" cy="40" rx="14" ry="18" className="a-balloon" /><path d="M80 58 L80 78" className="a-string" /></g>
      )}
      {kind === 'sweep' && <circle className="a-sweep" cx="30" cy="45" r="10" />}
      {kind === 'rocket' && (
        <g className="a-launch"><path d="M80 18 C90 30 90 52 86 62 L74 62 C70 52 70 30 80 18 Z" className="a-rocket" /><circle className="a-flame a-flame-1" cx="80" cy="68" r="5" /><circle className="a-flame a-flame-2" cx="80" cy="76" r="4" /></g>
      )}
      {kind === 'snow' && <g>{[20, 48, 76, 104, 132].map((x, i) => <circle key={x} className="a-snow" style={{ animationDelay: `${i * -0.7}s` }} cx={x} cy="0" r="2.4" />)}</g>}
    </svg>
  );
}

const FAQ = [
  ['Do I need to code?', 'No. Upload an image, describe the motion, adjust it visually, and copy the result into your site.'],
  ['Does the export need MotionForge to keep working?', 'No. Exports are plain HTML, CSS and JavaScript with the frames included. They contain no account details or API keys.'],
  ['What does the free mode do?', 'It removes plain backgrounds in your browser and animates with paths, scale, rotation, opacity and a simulated wing flap. Nothing is uploaded anywhere.'],
  ['When do Fast, Professional and bring-your-own-key arrive?', 'They run on the MotionForge server and only appear when the host has set up a provider. The Free mode always works in your browser, with no account.'],
  ['Is it accessible?', 'Exports respect the “reduce motion” setting and show a still frame instead.'],
];

export function Landing() {
  const { user } = useSession();
  return (
    <div className="landing">
      <header className="nav">
        <a className="brand" href="#/">MotionForge <span>AI</span></a>
        <nav aria-label="Main">
          <a href="#/docs">Docs</a>
          {user ? <a href="#/dashboard">Your projects</a> : <a href="#/login">Log in</a>}
          <a className="btn primary" href={user ? '#/new' : '#/signup'}>{user ? 'New project' : 'Sign up'}</a>
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
          {GALLERY.map(([title, prompt, art]) => (
            <li key={title}>
              <Art kind={art} />
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
            <tr><th scope="col" /><th scope="col">Free (available now)</th><th scope="col">Professional (needs provider setup)</th></tr>
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
        <p className="muted">The editor and exports are free to use. Paid plans appear in your Billing page once the host has turned them on.</p>
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
