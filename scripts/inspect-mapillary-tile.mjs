#!/usr/bin/env node
/**
 * Dumps what a Mapillary coverage tile actually contains: which layers it has,
 * how many features are in each, and the property names on the first feature.
 *
 * Worth having as a committed tool rather than a throwaway, because the tile
 * schema is the part of this pipeline the documentation describes least
 * accurately - `camera_type` alone cost a rebuild, and which zoom carries which
 * layer is not written down anywhere authoritative. Check here before assuming.
 *
 * Usage:
 *   node scripts/inspect-mapillary-tile.mjs 14 8402 5471
 *   node scripts/inspect-mapillary-tile.mjs --at 4.895 52.373 --zoom 6
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadEnv() {
  try {
    const raw = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // Already exported is fine.
  }
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

await loadEnv();
const token = process.env.MAPILLARY_TOKEN;
if (!token) {
  console.error('MAPILLARY_TOKEN is not set. Run `cp .env.example .env` and set your token.');
  process.exit(1);
}

const args = process.argv.slice(2);
let z;
let x;
let y;
if (args[0] === '--at') {
  const lon = Number(args[1]);
  const lat = Number(args[2]);
  z = Number(args[args.indexOf('--zoom') + 1] ?? 14);
  ({ x, y } = lonLatToTile(lon, lat, z));
} else {
  [z, x, y] = args.map(Number);
}

const config = JSON.parse(
  await fs.readFile(path.join(PROJECT_ROOT, 'config/pool-config.json'), 'utf8')
);

const url = `${config.mapillary.tilesUrl}/${z}/${x}/${y}?access_token=${encodeURIComponent(token)}`;
const response = await fetch(url);
console.log(`GET ${z}/${x}/${y} -> HTTP ${response.status}`);
if (!response.ok) process.exit(1);

const buffer = Buffer.from(await response.arrayBuffer());
console.log(`${(buffer.length / 1024).toFixed(1)} KiB`);

const tile = new VectorTile(new PbfReader(buffer));
for (const [name, layer] of Object.entries(tile.layers)) {
  const first = layer.length > 0 ? layer.feature(0) : null;
  console.log(`\nlayer "${name}": ${layer.length} features`);
  if (!first) continue;
  console.log(`  geometry type: ${first.type}`);
  console.log(`  properties: ${Object.keys(first.properties).join(', ')}`);
  console.log(`  first: ${JSON.stringify(first.properties).slice(0, 300)}`);
}
