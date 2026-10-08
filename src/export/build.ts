import { zipSync, strToU8 } from 'fflate';
import runtimeSource from '../runtime/motionforge-runtime.js?raw';
import type { Scene } from '../scene/schema';

export interface ExportInput {
  scene: Scene;
  /** assetId -> frame image URLs (data URIs in the editor). */
  assets: Record<string, string[]>;
}

/** Drop unused assets, and keep a single frame for assets that never flap. */
export function pruneAssets(input: ExportInput): ExportInput {
  const assets: Record<string, string[]> = {};
  for (const id of Object.keys(input.assets)) {
    const users = input.scene.objects.filter((o) => o.assetId === id);
    if (!users.length) continue;
    const animated = users.some((o) => o.flapsPerScroll > 0);
    assets[id] = animated ? input.assets[id] : input.assets[id].slice(0, 1);
  }
  return { scene: input.scene, assets };
}

function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/ /g, '\\u2028').replace(/ /g, '\\u2029');
}

const PAGE_STYLE = 'html,body{margin:0;padding:0;background:#eef2f7}';

/** Self-contained embed: paste into any page. Contains the runtime, scene and frames. */
export function buildSnippet(input: ExportInput, hostId = 'motionforge-1'): string {
  const { scene, assets } = pruneAssets(input);
  return [
    '<!-- MotionForge scroll animation: paste where the animation should start. -->',
    `<div id="${hostId}"></div>`,
    `<script>${runtimeSource}</script>`,
    `<script>MotionForge.mount(document.getElementById("${hostId}"),${json({ scene, assets })});</script>`,
  ].join('\n');
}

export function buildStandaloneHtml(input: ExportInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MotionForge animation</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${buildSnippet(input)}
</body>
</html>
`;
}

/** Preview document used inside the editor. Adds a message bridge; never exported. */
export function buildPreviewHtml(input: ExportInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:0;background:transparent}</style>
</head>
<body>
<div id="host"></div>
<script>${runtimeSource}</script>
<script>
var ctl = MotionForge.mount(document.getElementById("host"), ${json(input)});
addEventListener("message", function (e) {
  if (e.source !== parent) return;
  var d = e.data || {};
  if (d.type === "mf-scene") ctl.update(d.scene);
  if (d.type === "mf-scroll") scrollTo(0, d.y);
});
addEventListener("scroll", function () {
  var max = document.documentElement.scrollHeight - innerHeight;
  parent.postMessage({ type: "mf-progress", p: max > 0 ? Math.min(1, scrollY / max) : 0 }, "*");
}, { passive: true });
</script>
</body>
</html>
`;
}

function frameFile(assetId: string, i: number, url: string): string {
  const ext = url.startsWith('data:image/webp') ? 'webp' : 'png';
  return `${assetId}-${String(i).padStart(3, '0')}.${ext}`;
}

function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const INSTALL_GUIDE = `MotionForge export - installation guide
=====================================

This bundle works without a MotionForge account and makes no network requests.
It contains no API keys.

Files
-----
index.html            Open directly in a browser to test (works from disk).
snippet-hosted.html   Paste into Webflow (Embed element) or WordPress (Custom HTML block).
motionforge.js        The runtime. Upload next to the frames.
frames/               Transparent animation frames. Upload this folder too.
scene.json            The animation description (editable, validated on import).
MotionForgeScene.jsx  React component.

Plain HTML site
---------------
1. Copy motionforge.js and frames/ into your site, e.g. /motionforge/.
2. Paste snippet-hosted.html where the animation should start and replace
   BASE_URL with the public URL of that folder (no trailing slash).

Webflow
-------
1. Upload motionforge.js and the frames to any static host (Webflow Assets, your server, a CDN).
2. Add an Embed element and paste snippet-hosted.html, replacing BASE_URL.
   (Webflow limits Embed length, so the hosted snippet keeps frames as URLs.)
3. Make sure no parent element has overflow:hidden - that stops the scroll pinning.

WordPress
---------
1. Upload motionforge.js and frames/ via Media or FTP, e.g. /wp-content/uploads/motionforge/.
2. Add a Custom HTML block and paste snippet-hosted.html, replacing BASE_URL.

React / Next.js
---------------
1. Copy motionforge.js, scene.json and MotionForgeScene.jsx into your components folder.
2. Copy frames/ into public/motionforge/frames/.
3. Render <MotionForgeScene /> (client component).

Accessibility
-------------
Visitors who enable "reduce motion" see a still frame instead of scroll animation.
`;

export function buildZip(input: ExportInput): Uint8Array {
  const { scene, assets } = pruneAssets(input);
  const files: Record<string, Uint8Array> = {};
  const rel: Record<string, string[]> = {};
  const names: Record<string, string[]> = {};

  for (const id of Object.keys(assets)) {
    rel[id] = [];
    names[id] = [];
    assets[id].forEach((url, i) => {
      const name = frameFile(id, i, url);
      files[`frames/${name}`] = dataUrlToBytes(url);
      rel[id].push(`frames/${name}`);
      names[id].push(name);
    });
  }

  const hosted: Record<string, string[]> = {};
  for (const id of Object.keys(rel)) hosted[id] = rel[id].map((r) => `BASE_URL/${r}`);

  files['motionforge.js'] = strToU8(runtimeSource);
  files['scene.json'] = strToU8(JSON.stringify(scene, null, 2));
  files['index.html'] = strToU8(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MotionForge animation</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div id="motionforge-1"></div>
<script src="motionforge.js"></script>
<script>MotionForge.mount(document.getElementById("motionforge-1"),${json({ scene, assets: rel })});</script>
</body>
</html>
`);
  files['snippet-hosted.html'] = strToU8(
    `<div id="motionforge-1"></div>
<script src="BASE_URL/motionforge.js"></script>
<script>MotionForge.mount(document.getElementById("motionforge-1"),${json({ scene, assets: hosted })});</script>
`,
  );
  files['MotionForgeScene.jsx'] = strToU8(`import { useEffect, useRef } from 'react';
import './motionforge.js';
import scene from './scene.json';

const FRAMES = ${JSON.stringify(names)};

export default function MotionForgeScene({ base = '/motionforge' }) {
  const ref = useRef(null);
  useEffect(() => {
    const assets = {};
    for (const id of Object.keys(FRAMES)) assets[id] = FRAMES[id].map((f) => base + '/frames/' + f);
    const controller = window.MotionForge.mount(ref.current, { scene, assets });
    return () => controller.destroy();
  }, [base]);
  return <div ref={ref} />;
}
`);
  files['README.txt'] = strToU8(INSTALL_GUIDE);
  return zipSync(files, { level: 6 });
}
