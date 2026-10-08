import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildSnippet, buildStandaloneHtml, buildZip, pruneAssets } from '../src/export/build';
import { planFromPrompt } from '../src/ai/localPlanner';
import { emptyScene, newObject } from '../src/scene/defaults';
import { sanitizeFilename, sanitizeText, validateUpload } from '../src/lib/sanitize';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const scene = {
  ...emptyScene(),
  objects: [{ ...newObject('bird', 'main', 'Bird </script>'), ...planFromPrompt('bird fly bottom-left to top-right').patch }],
};
const input = { scene, assets: { main: [PNG, PNG, PNG], unused: [PNG] } };

describe('export', () => {
  it('standalone html is self-contained, keeps the runtime and has no secrets', () => {
    const html = buildStandaloneHtml(input);
    expect(html).toContain('MotionForge.mount');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).not.toMatch(/api[_-]?key|authorization|bearer/i);
    // the only URL allowed is the SVG XML namespace, which is an identifier and is never fetched
    expect(html.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//);
  });

  it('cannot be broken out of by user text in the scene', () => {
    const snippet = buildSnippet(input);
    expect(snippet.match(/<\/script>/g)).toHaveLength(2);
  });

  it('prunes unused assets and static frames', () => {
    const p = pruneAssets(input);
    expect(Object.keys(p.assets)).toEqual(['main']);
    const still = pruneAssets({ scene: { ...scene, objects: [{ ...scene.objects[0], flapsPerScroll: 0 }] }, assets: input.assets });
    expect(still.assets.main).toHaveLength(1);
  });

  it('zip contains runtime, hosted snippet, react component, frames and guide', () => {
    const files = unzipSync(buildZip(input));
    for (const f of ['index.html', 'snippet-hosted.html', 'motionforge.js', 'scene.json', 'MotionForgeScene.jsx', 'README.txt', 'frames/main-000.png']) {
      expect(files[f], f).toBeDefined();
    }
    expect(JSON.parse(strFromU8(files['scene.json'])).objects).toHaveLength(1);
  });
});

describe('input hygiene', () => {
  it('sanitises filenames and text', () => {
    expect(sanitizeFilename('../../etc/pass wd<script>.png')).toBe('pass-wdscript.png');
    expect(sanitizeText('  hi\u0000\n there  ')).toBe('hi there');
  });

  it('validates uploads', () => {
    expect(validateUpload({ type: 'image/png', size: 100 })).toBeNull();
    expect(validateUpload({ type: 'image/svg+xml', size: 100 })).not.toBeNull();
    expect(validateUpload({ type: 'image/png', size: 11 * 1024 * 1024 })).not.toBeNull();
  });
});
