import { zipSync, strToU8 } from 'fflate';
import runtimeSource from '../runtime/motionforge-runtime.js?raw';
import type { Scene } from '../scene/schema';

export interface ExportInput {
  scene: Scene;
  /** assetId -> frame image URLs (data URIs in the editor). */
  assets: Record<string, string[]>;
}

export interface ExportOptions {
  /** Where the small "Made with MotionForge" badge links to. Null or omitted means no badge (paid plans). */
  watermarkUrl?: string | null;
  /** Keep every Nth frame of animated images, for lighter files. */
  frameStep?: number;
  /** Which licence text goes in the ZIP. */
  commercial?: boolean;
}

/** Drop unused assets, keep a single frame for assets that never flap, and optionally thin the frames. */
export function pruneAssets(input: ExportInput, options: ExportOptions = {}): ExportInput {
  const step = Math.max(1, Math.floor(options.frameStep ?? 1));
  const assets: Record<string, string[]> = {};
  for (const id of Object.keys(input.assets)) {
    const users = input.scene.objects.filter((o) => o.assetId === id);
    if (!users.length) continue;
    const animated = users.some((o) => o.flapsPerScroll > 0);
    assets[id] = animated ? input.assets[id].filter((_, i) => i % step === 0) : input.assets[id].slice(0, 1);
  }
  return { scene: input.scene, assets };
}

function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(new RegExp(String.fromCharCode(91, 8232, 8233, 93), 'g'), '');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The free-plan badge. Plain HTML so it needs no script. */
export function badgeHtml(url: string): string {
  return `<a href="${esc(url)}" target="_blank" rel="noopener" style="position:fixed;right:12px;bottom:12px;z-index:2147483000;font:12px/1 system-ui,sans-serif;color:#fff;background:rgba(16,32,47,.82);padding:7px 10px;border-radius:999px;text-decoration:none">Made with MotionForge</a>`;
}

const PAGE_STYLE = 'html,body{margin:0;padding:0;background:#eef2f7}';

/** Self-contained embed: paste into any page. Contains the runtime, scene and frames. */
export function buildSnippet(input: ExportInput, hostId = 'motionforge-1', options: ExportOptions = {}): string {
  const { scene, assets } = pruneAssets(input, options);
  return [
    '<!-- MotionForge scroll animation: paste where the animation should start. -->',
    `<div id="${hostId}"></div>`,
    `<script>${runtimeSource}</script>`,
    `<script>MotionForge.mount(document.getElementById("${hostId}"),${json({ scene, assets })});</script>`,
    ...(options.watermarkUrl ? [badgeHtml(options.watermarkUrl)] : []),
  ].join('\n');
}

export function buildStandaloneHtml(input: ExportInput, options: ExportOptions = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MotionForge animation</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${buildSnippet(input, 'motionforge-1', options)}
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
wordpress-plugin/     A WordPress plugin that adds the [motionforge] shortcode.
LICENSE.txt           How you may use this export.

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
Option A (plugin, recommended):
1. Zip the folder wordpress-plugin/motionforge-animation (or upload the folder by FTP to wp-content/plugins/).
2. In WordPress: Plugins > Add New > Upload Plugin, then Activate.
3. Put [motionforge] in a page or post where the animation should start.
Option B (no plugin): add a Custom HTML block and paste snippet-hosted.html,
   after uploading motionforge.js and frames/ to your media folder and replacing BASE_URL.

React / Next.js
---------------
1. Copy motionforge.js, scene.json and MotionForgeScene.jsx into your components folder.
2. Copy frames/ into public/motionforge/frames/.
3. Render <MotionForgeScene /> (client component).

Accessibility
-------------
Visitors who enable "reduce motion" see a still frame instead of scroll animation.
`;

const LICENSE_COMMERCIAL = `MotionForge export licence

This export was made on a Professional plan. You may use it in personal and commercial
projects, including client work and products you sell, and you may remove or keep the
runtime's header comment. The animation images are yours (or whoever supplied them).
The runtime is provided as is, without warranty.
`;

const LICENSE_STANDARD = `MotionForge export licence

This export was made without a Professional plan. You may use it on your own sites and
projects. For commercial use, such as client work or products you sell, make the export on
a Professional plan. The animation images are yours (or whoever supplied them).
The runtime is provided as is, without warranty.
`;

function wordpressPlugin(badge: string | null): string {
  // The badge is plain HTML with double quotes only, so it is safe inside a single-quoted PHP string.
  const badgePhp = badge ? ` . '${badge.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : '';
  return `<?php
/**
 * Plugin Name: MotionForge Animation
 * Description: Adds the [motionforge] shortcode, a scroll-controlled animation made with MotionForge.
 * Version: 1.0.0
 * License: GPL-2.0-or-later
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_shortcode(
	'motionforge',
	function () {
		static $count = 0;
		++$count;

		$base   = plugins_url( '', __FILE__ );
		$scene  = json_decode( file_get_contents( __DIR__ . '/scene.json' ), true );
		$frames = json_decode( file_get_contents( __DIR__ . '/frames.json' ), true );
		if ( ! is_array( $scene ) || ! is_array( $frames ) ) {
			return '';
		}

		$assets = array();
		foreach ( $frames as $asset_id => $files ) {
			$assets[ $asset_id ] = array_map(
				function ( $file ) use ( $base ) {
					return $base . '/frames/' . $file;
				},
				$files
			);
		}

		$host_id = 'motionforge-' . $count;
		$config  = wp_json_encode( array( 'scene' => $scene, 'assets' => $assets ), JSON_HEX_TAG | JSON_HEX_AMP );

		wp_enqueue_script( 'motionforge-runtime', $base . '/motionforge.js', array(), '1.0.0', true );
		wp_add_inline_script(
			'motionforge-runtime',
			'document.addEventListener("DOMContentLoaded",function(){var h=document.getElementById(' . wp_json_encode( $host_id ) . ');if(h){MotionForge.mount(h,' . $config . ');}});'
		);

		return '<div id="' . esc_attr( $host_id ) . '"></div>'${badgePhp};
	}
);
`;
}

export function buildZip(input: ExportInput, options: ExportOptions = {}): Uint8Array {
  const { scene, assets } = pruneAssets(input, options);
  const badge = options.watermarkUrl ? badgeHtml(options.watermarkUrl) : null;
  const files: Record<string, Uint8Array> = {};
  const rel: Record<string, string[]> = {};
  const names: Record<string, string[]> = {};

  for (const id of Object.keys(assets)) {
    rel[id] = [];
    names[id] = [];
    assets[id].forEach((url, i) => {
      const name = frameFile(id, i, url);
      const bytes = dataUrlToBytes(url);
      files[`frames/${name}`] = bytes;
      files[`wordpress-plugin/motionforge-animation/frames/${name}`] = bytes;
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
${badge ?? ''}
</body>
</html>
`);
  files['snippet-hosted.html'] = strToU8(
    `<div id="motionforge-1"></div>
<script src="BASE_URL/motionforge.js"></script>
<script>MotionForge.mount(document.getElementById("motionforge-1"),${json({ scene, assets: hosted })});</script>
${badge ?? ''}
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
  return (
    <>
      <div ref={ref} />
${badge ? `      ${badge}\n` : ''}    </>
  );
}
`);
  const plugin = 'wordpress-plugin/motionforge-animation';
  files[`${plugin}/motionforge-animation.php`] = strToU8(wordpressPlugin(badge));
  files[`${plugin}/motionforge.js`] = strToU8(runtimeSource);
  files[`${plugin}/scene.json`] = strToU8(JSON.stringify(scene));
  files[`${plugin}/frames.json`] = strToU8(JSON.stringify(names));
  files['LICENSE.txt'] = strToU8(options.commercial ? LICENSE_COMMERCIAL : LICENSE_STANDARD);
  files['README.txt'] = strToU8(INSTALL_GUIDE);
  return zipSync(files, { level: 6 });
}
