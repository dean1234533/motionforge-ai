const EXAMPLE = `{
  "scene": { "width": 1440, "height": 900, "background": "transparent" },
  "objects": [{
    "id": "bird",
    "assetId": "bird",
    "widthPct": 22,
    "flapsPerScroll": 14,
    "path": [
      { "progress": 0,   "x": -15, "y": 110 },
      { "progress": 0.5, "x": 45,  "y": 42 },
      { "progress": 1,   "x": 115, "y": -10 }
    ],
    "rotation": [0], "scale": [0.75, 1, 0.85], "opacity": [1]
  }],
  "scroll": { "length": 1800, "scrub": true, "reverse": true, "smoothing": 0.15 }
}`;

export function Docs() {
  return (
    <div className="landing docs">
      <header className="nav">
        <a className="brand" href="#/">MotionForge <span>AI</span></a>
        <nav aria-label="Main"><a className="btn primary" href="#/editor">Open editor</a></nav>
      </header>
      <article className="section">
        <h1>Documentation</h1>

        <h2>How it works</h2>
        <p>Every animation is stored as a strict JSON scene. The editor, the AI planner and the exported runtime all use that same format. Scenes are validated before they are rendered, and nothing in a scene is ever executed as code.</p>

        <h2>The scene format</h2>
        <pre><code>{EXAMPLE}</code></pre>
        <ul>
          <li><b>path</b>: keyframes where <code>x</code> and <code>y</code> are percentages of the viewport. Values outside 0 to 100 are off-screen. The runtime draws a smooth curve through them.</li>
          <li><b>rotation, scale, opacity, blur</b>: lists of values spread evenly across the animation.</li>
          <li><b>flapsPerScroll</b>: how many full wing beats happen over the whole scroll.</li>
          <li><b>scroll.length</b>: pixels of scrolling the animation takes. <b>reverse</b> makes scrolling up play it backwards.</li>
        </ul>

        <h2>Plain-English commands</h2>
        <p>Try “make the bird fly more slowly”, “make the wings flap faster”, “move the ending position higher”, “make it smaller on mobile”, “reverse the direction” or “make it feel more cinematic”. A description of a new movement replaces the selected layer's motion.</p>

        <h2>Effects, shapes and lines</h2>
        <p>Beyond images you can add particle <b>effects</b> (smoke, fire, water, sparkles, snow and rain), simple <b>shapes</b> and <b>lines</b>. Each is a layer with its own path and settings. MotionForge picks the right way to draw each one: images and light particle effects use canvas, heavy particle scenes (250 or more particles) use WebGL when the browser supports it, shapes are plain HTML/CSS elements, and lines are SVG that draw themselves in as you scroll.</p>
        <p>A layer can <b>follow another layer</b> (put fire behind a rocket, or trace a bird's flight path with a line) and can have <b>parallax</b>, drifting against the scroll to create depth. Try “add smoke behind it”, “add rain”, “add a line showing its path” or “give it more depth”.</p>

        <h2>Generating video and images</h2>
        <p>With an account, the Fast and Professional modes turn a still into video. The subject is filmed on a flat green or blue screen, and that colour is keyed out of every frame so you get transparent frames. “Create with AI” makes new images from a description, and “Upscale” enlarges an image so frames are sharper. Each shows its cost and asks before it spends credits; with your own provider key they cost no credits.</p>

        <h2>Teams and plans</h2>
        <p>The Professional plan can create teams. Invite people by email: owners choose editor or viewer, and the invitation link works only for that address. Everyone on a team can open its projects; viewers can look and export, editors can change them. Free exports carry a small “Made with MotionForge” badge, Creator and Professional exports do not and use sharper frames, and Professional adds lighter-file options, a commercial licence and priority processing.</p>

        <h2>Installing an export</h2>
        <p>The export screen has a step-by-step guide for HTML, Webflow, WordPress and React. The ZIP also contains a <code>README.txt</code> with the same steps, a ready-to-upload <b>WordPress plugin</b> (it adds a <code>[motionforge]</code> shortcode) and a licence file.</p>

        <h2>Good to know</h2>
        <ul>
          <li>Keep the animation's container free of <code>overflow:hidden</code>; it stops the scroll pinning.</li>
          <li>Visitors with “reduce motion” enabled see a still frame.</li>
          <li>Your project is saved in this browser. Images never leave your device in the free mode.</li>
        </ul>
      </article>
    </div>
  );
}
