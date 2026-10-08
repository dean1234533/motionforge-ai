import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildSnippet, buildStandaloneHtml, buildZip, pruneAssets } from '../src/export/build';
import { planFromPrompt } from '../src/ai/localPlanner';
import { emptyScene, newObject } from '../src/scene/defaults';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const scene = { ...emptyScene(), objects: [{ ...newObject('bird', 'main', 'Bird'), ...planFromPrompt('bird fly bottom-left to top-right').patch }] };
const input = { scene, assets: { main: Array.from({ length: 24 }, () => PNG) } };

describe('free badge', () => {
  it('is on free exports and absent on paid ones', () => {
    const free = buildStandaloneHtml(input, { watermarkUrl: 'https://motionforge.example.com/' });
    expect(free).toContain('Made with MotionForge');
    expect(free).toContain('href="https://motionforge.example.com/"');
    expect(buildStandaloneHtml(input, { watermarkUrl: null })).not.toContain('Made with MotionForge');
    expect(buildStandaloneHtml(input)).not.toContain('Made with MotionForge');
  });

  it('cannot be used to inject markup', () => {
    const html = buildSnippet(input, 'motionforge-1', { watermarkUrl: 'https://x.test/"><script>alert(1)</script>' });
    expect(html).not.toContain('"><script>alert(1)');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('is in every file of the ZIP when requested, and in none when not', () => {
    const withBadge = unzipSync(buildZip(input, { watermarkUrl: 'https://m.test/' }));
    for (const f of ['index.html', 'snippet-hosted.html', 'MotionForgeScene.jsx', 'wordpress-plugin/motionforge-animation/motionforge-animation.php']) {
      expect(strFromU8(withBadge[f]), f).toContain('Made with MotionForge');
    }
    const without = unzipSync(buildZip(input, { watermarkUrl: null }));
    for (const f of Object.keys(without).filter((n) => /\.(html|jsx|php)$/.test(n))) expect(strFromU8(without[f]), f).not.toContain('Made with MotionForge');
  });
});

describe('advanced export options', () => {
  it('thins animated frames but keeps single images single', () => {
    expect(pruneAssets(input).assets.main).toHaveLength(24);
    expect(pruneAssets(input, { frameStep: 2 }).assets.main).toHaveLength(12);
    expect(pruneAssets(input, { frameStep: 4 }).assets.main).toHaveLength(6);
    const still = { scene: { ...scene, objects: [{ ...scene.objects[0], flapsPerScroll: 0 }] }, assets: input.assets };
    expect(pruneAssets(still, { frameStep: 2 }).assets.main).toHaveLength(1);
  });

  it('writes a licence that matches the plan', () => {
    const text = (opts: { commercial?: boolean }) => strFromU8(unzipSync(buildZip(input, opts))['LICENSE.txt']).replace(/\s+/g, ' ');
    expect(text({ commercial: true })).toContain('personal and commercial projects');
    expect(text({})).toContain('make the export on a Professional plan');
  });
});

describe('WordPress plugin', () => {
  it('ships the shortcode plugin with scene, runtime and frames', () => {
    const files = unzipSync(buildZip(input, { frameStep: 2 }));
    const dir = 'wordpress-plugin/motionforge-animation/';
    for (const f of ['motionforge-animation.php', 'motionforge.js', 'scene.json', 'frames.json', 'frames/main-000.png']) expect(files[dir + f], f).toBeDefined();
    const php = strFromU8(files[dir + 'motionforge-animation.php']);
    expect(php).toContain("add_shortcode(\n\t'motionforge'");
    expect(php).toContain('JSON_HEX_TAG');
    expect(Object.keys(JSON.parse(strFromU8(files[dir + 'frames.json'])))).toEqual(['main']);
    expect(JSON.parse(strFromU8(files[dir + 'frames.json'])).main).toHaveLength(12);
  });

  const hasPhp = spawnSync('php', ['-v']).status === 0;
  it.skipIf(!hasPhp)('is valid PHP, even with an awkward badge URL', () => {
    for (const watermarkUrl of [null, "https://x.test/it's?a=1&b=\\2"]) {
      const files = unzipSync(buildZip(input, { watermarkUrl }));
      const dir = mkdtempSync(join(tmpdir(), 'mf-php-'));
      const file = join(dir, 'plugin.php');
      writeFileSync(file, files['wordpress-plugin/motionforge-animation/motionforge-animation.php']);
      const r = spawnSync('php', ['-l', file], { encoding: 'utf8' });
      expect(r.stdout + r.stderr, String(watermarkUrl)).toContain('No syntax errors');
    }
  });
});
