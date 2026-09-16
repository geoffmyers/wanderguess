#!/usr/bin/env node
/**
 * Renders the real EquirectViewer against a real panorama and screenshots it.
 *
 * Why this exists: the headless Chrome available in this environment has no
 * WebGL at all - `getContext('webgl')` returns null - so the viewer silently
 * takes its flat-image fallback and the shader path never runs. Every other
 * part of the game is covered by vitest, but the projection math and GL
 * plumbing are exactly the parts unit tests cannot reach.
 *
 * This bundles lib/viewer/equirect.ts with esbuild, drives it in Chromium with
 * SwiftShader (software GL), and writes a PNG you can actually look at. A black
 * or uniform image means the shader ran but sampled nothing - which is the
 * failure mode a "did it throw?" check would happily call success.
 *
 * It also verifies the one thing easy mode depends on: which way a positive
 * `initialBearingDeg` turns the view. That is a sign convention buried in the
 * shader, and getting it backwards would open every easy round facing exactly
 * away from its landmark - a failure that looks completely normal in isolation,
 * because the round still renders a street. `--bearings` renders the same
 * panorama at several bearings side by side, above the raw equirectangular
 * source, so the answer is visible rather than argued: a positive bearing must
 * show what sits to the RIGHT of the source image's centre.
 *
 * Usage:
 *   node scripts/verify-viewer.mjs                        # resolve a panorama from the pool
 *   node scripts/verify-viewer.mjs <image-id>             # a specific Mapillary image
 *   node scripts/verify-viewer.mjs <image-id> --bearings -90,0,90
 *
 * Auto-pan is deliberately NOT checked here. Chromium's headless virtual-time
 * mode advances timers without producing matching animation frames, so a sweep
 * renders as barely moved whether its maths is right or wrong - a test that
 * cannot fail is worse than none. `autoPanStep` is a pure function for exactly
 * that reason and is covered in lib/viewer/equirect.test.ts.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(PROJECT_ROOT, '.viewer-verify');

async function loadEnv() {
  try {
    const raw = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* variables may already be exported */
  }
}

/**
 * Chromium runs inside the official Playwright image, never on the host.
 * This TrueNAS host has a read-only /usr and no apt, so the cached Playwright
 * Chromium cannot resolve its shared libraries (`libatk-1.0.so.0: cannot open
 * shared object file`) and a host-level install is not possible by design.
 */
const PLAYWRIGHT_IMAGE =
  process.env.PLAYWRIGHT_IMAGE ?? 'mcr.microsoft.com/playwright:v1.60.0-noble';

async function resolvePanorama(imageId, token) {
  const url = `https://graph.mapillary.com/${imageId}?fields=thumb_2048_url,camera_type`;
  const res = await fetch(url, { headers: { Authorization: `OAuth ${token}` } });
  if (!res.ok) throw new Error(`Mapillary returned ${res.status} for ${imageId}`);
  const data = await res.json();
  if (!data.thumb_2048_url) throw new Error(`No thumbnail URL for ${imageId}`);
  return data;
}

async function pickImageIdFromPool() {
  for (const rel of ['public/data/locations.json', 'scripts/.pool-cache.json']) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, rel), 'utf8'));
      const list = raw.locations ?? raw.accepted ?? [];
      if (list.length) return list[Math.floor(list.length / 2)].id;
    } catch {
      /* try the next source */
    }
  }
  throw new Error('No pool found - pass a Mapillary image ID explicitly');
}

const PAGE = (panoramaUrl, bearings) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#111;font:13px monospace;color:#8fd}
  .row{display:flex}
  .cell{width:${Math.floor(1200 / bearings.length)}px;height:420px;position:relative}
  .cell canvas{display:block;width:100%;height:100%}
  .label{position:absolute;top:4px;left:6px;background:#000a;padding:2px 6px;color:#0f0}
  /* The source image, with its centre marked: the whole verification is
     whether a positive bearing shows what lies to the RIGHT of that mark. */
  #source{width:1200px;display:block}
  #centre{position:absolute;top:0;bottom:0;left:50%;width:2px;background:#f0f}
  #wrap{position:relative;width:1200px}
  #status{color:#0f0;padding:4px 6px}
</style></head><body>
<div class="row" id="views"></div>
<div id="wrap"><img id="source" crossorigin="anonymous"><div id="centre"></div></div>
<div id="status">starting…</div>
<script type="module">
  import { EquirectViewer } from './equirect.js';
  const status = document.getElementById('status');
  const views = document.getElementById('views');
  const bearings = ${JSON.stringify(bearings)};
  window.__result = { ok: false, stage: 'init' };

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    document.getElementById('source').src = img.src;
    try {
      for (const bearing of bearings) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        const canvas = document.createElement('canvas');
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = 'bearing ' + bearing + '\\u00b0';
        cell.append(canvas, label);
        views.append(cell);
        new EquirectViewer(canvas, { initialBearingDeg: bearing }).setImage(img);
      }
      window.__result = { ok: true, stage: 'rendered', w: img.width, h: img.height };
      status.textContent = 'rendered ' + img.width + 'x' + img.height +
        ' at bearings ' + bearings.join(', ');
    } catch (e) {
      window.__result = { ok: false, stage: 'setImage', error: String(e) };
      status.textContent = 'setImage failed: ' + e;
    }
  };
  img.onerror = () => {
    window.__result = { ok: false, stage: 'image-load' };
    status.textContent = 'image load failed';
  };
  img.src = ${JSON.stringify(panoramaUrl)};
</script></body></html>`;


async function main() {
  await loadEnv();
  const token = process.env.MAPILLARY_TOKEN;
  if (!token) throw new Error('MAPILLARY_TOKEN is not set (op inject -i .env.tpl -o .env)');

  const argv = process.argv.slice(2);
  const bearingIndex = argv.indexOf('--bearings');
  const bearings =
    bearingIndex === -1
      ? [0]
      : argv[bearingIndex + 1].split(',').map((b) => Number(b.trim()));
  const positional = argv.filter((a, i) => !a.startsWith('--') && i !== bearingIndex + 1);

  const imageId = positional[0] || (await pickImageIdFromPool());
  const meta = await resolvePanorama(imageId, token);
  console.log(`[verify] image ${imageId} (camera_type=${meta.camera_type})`);
  console.log(`[verify] bearings ${bearings.join(', ')}`);

  await fs.mkdir(OUT_DIR, { recursive: true });

  // Bundle the real viewer source - not a copy of the shader.
  await execFileAsync(path.join(PROJECT_ROOT, 'node_modules/.bin/esbuild'), [
    path.join(PROJECT_ROOT, 'lib/viewer/equirect.ts'),
    '--bundle',
    '--format=esm',
    `--outfile=${path.join(OUT_DIR, 'equirect.js')}`,
  ]);

  const pagePath = path.join(OUT_DIR, 'index.html');
  await fs.writeFile(pagePath, PAGE(meta.thumb_2048_url, bearings));

  const shot = path.join(OUT_DIR, 'panorama.png');
  console.log(`[verify] chromium via ${PLAYWRIGHT_IMAGE}`);

  // --user and HOME=/tmp keep the container from writing root-owned files into
  // the bind mount, which breaks ordinary edits and Dropbox sync.
  const uid = process.getuid();
  const gid = process.getgid();
  const inner = [
    'CHROME=$(find /ms-playwright -type f -name chrome | head -1);',
    'exec "$CHROME"',
    '--headless=new --no-sandbox --disable-gpu-sandbox',
    // Software GL - the whole point, since no GPU stack is reachable here.
    '--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader',
    '--allow-file-access-from-files --hide-scrollbars --window-size=1200,720',
    '--screenshot=/work/panorama.png --virtual-time-budget=20000',
    'file:///work/index.html',
  ].join(' ');

  await execFileAsync(
    'docker',
    [
      'run', '--rm',
      '-v', `${OUT_DIR}:/work`,
      '-w', '/work',
      '--user', `${uid}:${gid}`,
      '-e', 'HOME=/tmp',
      PLAYWRIGHT_IMAGE,
      'bash', '-c', inner,
    ],
    { timeout: 300_000 }
  ).catch((e) => {
    // Chromium exits non-zero in some headless paths even after writing the PNG.
    console.warn(`[verify] chromium exited oddly: ${String(e.message).slice(0, 300)}`);
  });

  const stat = await fs.stat(shot).catch(() => null);
  if (!stat) throw new Error('Chromium produced no screenshot');
  console.log(`[verify] screenshot: ${shot} (${stat.size} bytes)`);
  console.log('[verify] Open it. A street scene means the shader path works; a');
  console.log('[verify] flat black frame means it ran but sampled nothing.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
