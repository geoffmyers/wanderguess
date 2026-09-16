#!/usr/bin/env node
/**
 * Builds public/data/locations.json - the pool of panoramas Wanderguess plays from.
 *
 * Three seeding passes feed one pool, because the three difficulty modes cannot
 * be filtered out of a single one. Panoramas next to world-famous landmarks are
 * a vanishingly small fraction of Mapillary, so filtering a city-seeded pool for
 * them returns approximately nothing; and a city-seeded pool cannot contain a
 * rural road by construction. Each pass seeds on what its mode is actually about:
 *
 *   cities    - GeoNames cities inside a region bbox        (the original pass)
 *   landmarks - Wikidata landmark coordinates               (feeds easy mode)
 *   rural     - random points on the Mapillary coverage graph (makes hard honest)
 *
 * Pipeline, per pass:
 *   1. Fetch GeoNames reference dumps (cities, admin1 regions, country names).
 *   2. Seed, and ask Mapillary for equirectangular panoramas near each seed.
 *   3. Verify each hit with Nominatim so the city and region answers are honest.
 *   4. Bake four plausible sibling distractors per tier from GeoNames.
 *   5. Classify every accepted location as easy / medium / hard and emit.
 *
 * Difficulty is decided in step 5 from the data, not from which pass found the
 * location: a city-pass panorama standing under the Colosseum is an easy
 * location, and recording otherwise would make the field describe the builder
 * rather than the place.
 *
 * Everything tunable lives in config/pool-config.json and
 * config/landmark-config.json. Nothing here invents a value of its own.
 *
 * Usage:
 *   npm run build-pool                      # every pass, resuming from cache
 *   npm run build-pool -- --pass landmarks  # one pass only
 *   npm run build-pool -- --force           # ignore the cache and rebuild
 *   npm run build-pool -- --limit 50        # small pool for a smoke test
 *   npm run build-pool -- --emit-only       # re-emit and reclassify the cache
 */

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';

import { VectorTile } from '@mapbox/vector-tile';
// pbf v4 renamed its exports: there is no default, only PbfReader/PbfWriter.
import { PbfReader } from 'pbf';

import { ensureLandmarkIndex } from './build-landmark-index.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (...args) => console.log('[pool]', ...args);
const warn = (...args) => console.warn('[pool]', ...args);

/** Case- and accent-insensitive comparison, so "Ile-de-France" matches "Île-de-France". */
function normalizeName(value) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Compass bearing in degrees from one point to another, 0 = north.
 *
 * This is what lets an easy round open facing its landmark. The panorama's own
 * `compass_angle` says which way its image centre points, so the difference
 * between the two is where the landmark sits within the image - a physical fact
 * about the panorama, independent of any viewer's yaw convention.
 *
 * That compass_angle really is the image centre, rather than north, was checked
 * rather than assumed: for image 2104698996700350 Mapillary reports 243.2, the
 * geographic bearing to the next image in its sequence is 245.4, and the centre
 * of the rendered view is the road ahead. A panorama silently rotated by its
 * own heading would open every easy round pointing somewhere arbitrary while
 * still rendering a perfectly ordinary street, so nothing here would flag it.
 */
function bearingDeg(fromLat, fromLon, toLat, toLon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const phi1 = toRad(fromLat);
  const phi2 = toRad(toLat);
  const dLambda = toRad(toLon - fromLon);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Capture date as YYYY-MM-DD, whatever form it arrived in.
 *
 * The bbox path formatted this and the tile path did not, so 52 of the first
 * 251 cached locations carry a raw epoch-millisecond number instead - and the
 * reveal screen prints the field verbatim, so those rounds ended with
 * "captured 1680205258466". Normalised at emit as well as on the way in, so an
 * existing cache is repaired by `--emit-only` rather than needing a rebuild.
 */
function normalizeCapturedAt(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(typeof value === 'number' ? value : Number(value) || value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** Signed degrees in (-180, 180], so a landmark just behind you reads as -175 rather than 185. */
function relativeBearing(bearing, heading) {
  return ((((bearing - heading) % 360) + 540) % 360) - 180;
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const PASSES = ['cities', 'landmarks', 'rural', 'streets'];

function parseArgs(argv) {
  const args = { force: false, limit: null, emitOnly: false, passes: [...PASSES] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') args.force = true;
    if (argv[i] === '--emit-only') args.emitOnly = true;
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]);
    if (argv[i] === '--pass') {
      const requested = (argv[i + 1] ?? '').split(',').map((p) => p.trim());
      const unknown = requested.filter((p) => !PASSES.includes(p));
      if (unknown.length > 0) {
        throw new Error(`Unknown pass: ${unknown.join(', ')}. Choose from ${PASSES.join(', ')}.`);
      }
      args.passes = requested;
    }
  }
  return args;
}

/** Minimal .env reader - avoids a dependency for three variables. */
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
    // No .env is fine when the variables are already exported.
  }
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, relativePath), 'utf8'));
}

// ------------------------------------------------------------- geonames data

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function ensureGeonames(config) {
  const dir = path.join(PROJECT_ROOT, config.output.geonamesDir);
  await fs.mkdir(dir, { recursive: true });

  const { citiesDumpUrl, admin1DumpUrl, countryInfoUrl } = config.distractors.geonames;
  const citiesZip = path.join(dir, 'cities.zip');
  const citiesTxt = path.join(dir, path.basename(citiesDumpUrl).replace('.zip', '.txt'));
  const admin1Txt = path.join(dir, 'admin1CodesASCII.txt');
  const countryTxt = path.join(dir, 'countryInfo.txt');

  if (!(await exists(citiesTxt))) {
    log('downloading GeoNames cities dump…');
    await download(citiesDumpUrl, citiesZip);
    try {
      await execFileAsync('unzip', ['-o', citiesZip, '-d', dir]);
    } catch (error) {
      throw new Error(
        `Could not unzip the GeoNames cities dump (${error.message}). ` +
          'Install unzip, or extract it manually into ' + dir
      );
    }
    await fs.rm(citiesZip, { force: true });
  }
  if (!(await exists(admin1Txt))) {
    log('downloading GeoNames admin1 codes…');
    await download(admin1DumpUrl, admin1Txt);
  }
  if (!(await exists(countryTxt))) {
    log('downloading GeoNames country info…');
    await download(countryInfoUrl, countryTxt);
  }

  return { citiesTxt, admin1Txt, countryTxt };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** cities15000.txt is tab-separated; see https://download.geonames.org/export/dump/readme.txt */
async function parseCities(file, minPopulation) {
  const raw = await fs.readFile(file, 'utf8');
  const cities = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    const population = Number(f[14]);
    if (!Number.isFinite(population) || population < minPopulation) continue;
    cities.push({
      name: f[1],
      lat: Number(f[4]),
      lon: Number(f[5]),
      country: f[8],
      admin1: f[10],
      population,
    });
  }
  return cities;
}

/** admin1CodesASCII.txt: "CC.code<TAB>name<TAB>asciiName<TAB>geonameId" */
async function parseAdmin1(file) {
  const raw = await fs.readFile(file, 'utf8');
  const byKey = new Map();
  const byCountry = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [key, name] = line.split('\t');
    if (!key || !name) continue;
    const [country] = key.split('.');
    byKey.set(key, name);
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country).push(name);
  }
  return { byKey, byCountry };
}

/** countryInfo.txt: comment lines start with '#'; ISO is column 0, name column 4. */
async function parseCountries(file) {
  const raw = await fs.readFile(file, 'utf8');
  const names = new Map();
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f[0] && f[4]) names.set(f[0], f[4]);
  }
  return names;
}

// ------------------------------------------------------- mapillary: tiles

/** Slippy-map tile containing a coordinate at the given zoom. */
function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

/**
 * Every 360 panorama in one coverage tile.
 *
 * This is the discovery path, and it is a different order of magnitude from
 * querying /images by bbox. One z14 tile over central Amsterdam returns 63,837
 * images carrying 15,723 panoramas in a single request; the best bbox query
 * managed 263 before the server refused on data volume. Tiles are pre-rendered
 * and fixed-size, so they never return the HTTP 500 that forced the bbox path
 * to shrink its box and retry - a tile with no coverage simply reports zero,
 * which is information rather than an error.
 *
 * The tile carries everything needed to choose a candidate (id, position,
 * capture time, quality) except the creator's username, which attribution
 * requires - so exactly one Graph API call per *accepted* location follows,
 * instead of several per attempt.
 */
async function fetchTilePanoramas(z, x, y, config, token) {
  const url = `${config.mapillary.tilesUrl}/${z}/${x}/${y}?access_token=${encodeURIComponent(token)}`;
  const response = await fetch(url);
  if (!response.ok) {
    warn(`tile ${z}/${x}/${y} returned ${response.status}`);
    return [];
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const layer = new VectorTile(new PbfReader(buffer)).layers[config.mapillary.tileImageLayer];
  if (!layer) return [];

  const panoramas = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const props = feature.properties;
    if (!props.is_pano) continue;

    const id = props.id ?? props.image_id;
    if (!id) continue;

    const [lon, lat] = feature.toGeoJSON(x, y, z).geometry.coordinates;
    panoramas.push({
      id: String(id),
      lat,
      lon,
      capturedAt: props.captured_at,
      qualityScore: props.quality_score ?? null,
      sequenceId: props.sequence_id ?? null,
      // Which way the image centre faces. Present on the tile, so an easy
      // location costs no extra request to point at its landmark.
      compassAngle: Number.isFinite(props.compass_angle) ? props.compass_angle : null,
    });
  }
  return panoramas;
}

/**
 * Panoramic sequences in one coverage tile, as a sampler for where imagery
 * exists at all.
 *
 * The `image` point layer only exists at zoom 14, but `sequence` lines are
 * rendered from zoom 6 up - and a coarse tile spans enough ground that its
 * several-megabyte download amortises over many accepted locations. That is
 * what makes random sampling viable: a random z8 tile over a region usually has
 * coverage somewhere in it, while a random z14 tile over the same region is
 * almost always empty, and neither Mapillary nor a bbox query can tell you
 * where the coverage is without asking.
 *
 * Each feature names one image_id, so a sampled sequence resolves to a real
 * panorama with one Graph call - the sequence geometry itself is simplified at
 * coarse zooms and is not accurate enough to geocode from.
 */
async function fetchTileSequences(z, x, y, config, token) {
  const url = `${config.mapillary.tilesUrl}/${z}/${x}/${y}?access_token=${encodeURIComponent(token)}`;
  const response = await fetch(url);
  if (!response.ok) {
    warn(`sequence tile ${z}/${x}/${y} returned ${response.status}`);
    return [];
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const layer = new VectorTile(new PbfReader(buffer)).layers[config.mapillary.tileSequenceLayer];
  if (!layer) return [];

  const { minCapturedYear, minQualityScore } = config.filters;
  const sequences = [];
  for (let i = 0; i < layer.length; i++) {
    const props = layer.feature(i).properties;
    if (!props.is_pano || !props.image_id) continue;
    if (new Date(props.captured_at ?? 0).getUTCFullYear() < minCapturedYear) continue;
    if (props.quality_score != null && props.quality_score < minQualityScore) continue;
    sequences.push(String(props.image_id));
  }
  return sequences;
}

/**
 * Picks a panorama near a seed city from its coverage tile.
 *
 * Tiles are cached because neighbouring seed cities frequently share one, and a
 * dense tile is several megabytes - refetching it per seed would undo the win.
 */
async function findPanoramaViaTiles(city, config, token, tileCache) {
  const z = config.mapillary.tileZoom;
  const { x, y } = lonLatToTile(city.lon, city.lat, z);
  const key = `${z}/${x}/${y}`;

  let panoramas = tileCache.get(key);
  if (!panoramas) {
    panoramas = await fetchTilePanoramas(z, x, y, config, token);
    // Bounded so a long run cannot accumulate every tile it has ever seen.
    if (tileCache.size >= config.mapillary.tileCacheSize) {
      tileCache.delete(tileCache.keys().next().value);
    }
    tileCache.set(key, panoramas);
  }
  if (panoramas.length === 0) return null;

  const { minCapturedYear, maxCityDistanceKm, minQualityScore } = config.filters;
  const eligible = panoramas.filter(
    (p) =>
      new Date(p.capturedAt ?? 0).getUTCFullYear() >= minCapturedYear &&
      (p.qualityScore == null || p.qualityScore >= minQualityScore) &&
      haversineKm(p.lat, p.lon, city.lat, city.lon) <= maxCityDistanceKm
  );
  if (eligible.length === 0) return null;

  return shuffle(eligible)[0];
}

/**
 * The two things the coverage tile cannot supply: the creator username that
 * attribution requires, and the corrected heading an easy round needs.
 *
 * `computed_compass_angle` is Mapillary's structure-from-motion correction and
 * is the heading to trust. The tile carries only the raw `compass_angle`, which
 * is often a plain 0.0 where the camera recorded none - the Arc de Triomphe
 * panorama is one, reporting 0.0 against a computed 134.9. A round baked from
 * the raw value there opened 121 degrees away from an arch standing dead ahead,
 * and rendered an unremarkable Paris street while doing it, so nothing about
 * the result looked wrong.
 *
 * One call, made once per accepted location, which is what the creator name
 * already cost.
 */
async function fetchImageAttribution(imageId, config, token) {
  const url = `${config.mapillary.graphUrl}/${imageId}?fields=creator,computed_compass_angle`;
  const response = await fetch(url, { headers: { Authorization: `OAuth ${token}` } });
  if (!response.ok) return { creator: 'unknown', computedCompassAngle: null };
  const data = await response.json();
  return {
    creator: data?.creator?.username ?? 'unknown',
    computedCompassAngle: Number.isFinite(data?.computed_compass_angle)
      ? data.computed_compass_angle
      : null,
  };
}

/**
 * Everything about one image, for candidates that arrived as a bare ID.
 *
 * The rural pass samples sequence lines rather than image points, so it has an
 * image_id and nothing else - no position accurate enough to geocode from, and
 * no camera type. One Graph call supplies all of it, which is the same per
 * accepted location cost the other passes already pay for the creator name.
 */
async function fetchImageMeta(imageId, config, token) {
  const fields = config.mapillary.imageFields.join(',');
  const url = `${config.mapillary.graphUrl}/${imageId}?fields=${fields}`;
  const response = await fetch(url, { headers: { Authorization: `OAuth ${token}` } });
  if (!response.ok) return null;

  const image = await response.json();
  const coordinates =
    image?.computed_geometry?.coordinates ?? image?.geometry?.coordinates ?? null;
  if (!coordinates) return null;

  // camera_type is checked here rather than trusted from the tile's is_pano:
  // the two are independent statements from Mapillary and this is the only
  // point in the rural path where the actual camera type is visible.
  if (!config.filters.cameraTypes.includes(image.camera_type)) return null;

  return {
    id: String(image.id),
    lon: coordinates[0],
    lat: coordinates[1],
    capturedAt: new Date(image.captured_at).toISOString().slice(0, 10),
    creator: image.creator?.username ?? 'unknown',
    compassAngle: Number.isFinite(image.compass_angle) ? image.compass_angle : null,
    computedCompassAngle: Number.isFinite(image.computed_compass_angle)
      ? image.computed_compass_angle
      : null,
  };
}

/**
 * A panorama standing close enough to a landmark that the landmark is the
 * obvious subject - within the radius its own kind earns, from a 900 m tower
 * down to a 150 m fountain.
 *
 * Note what this does NOT establish: that the landmark is actually visible. A
 * building between the two occludes it completely, and no amount of proximity
 * says otherwise. What closes most of that gap is the bearing baked alongside,
 * which opens the round already facing the landmark instead of leaving the
 * player to find it.
 */
async function findPanoramaNearLandmark(landmark, config, token, tileCache) {
  const z = config.mapillary.tileZoom;
  const { x, y } = lonLatToTile(landmark.lon, landmark.lat, z);
  const key = `${z}/${x}/${y}`;

  let panoramas = tileCache.get(key);
  if (!panoramas) {
    panoramas = await fetchTilePanoramas(z, x, y, config, token);
    if (tileCache.size >= config.mapillary.tileCacheSize) {
      tileCache.delete(tileCache.keys().next().value);
    }
    tileCache.set(key, panoramas);
  }
  if (panoramas.length === 0) return null;

  const { minCapturedYear, minQualityScore } = config.filters;
  const radiusKm = landmark.radiusM / 1000;

  const eligible = panoramas.filter(
    (p) =>
      new Date(p.capturedAt ?? 0).getUTCFullYear() >= minCapturedYear &&
      (p.qualityScore == null || p.qualityScore >= minQualityScore) &&
      haversineKm(p.lat, p.lon, landmark.lat, landmark.lon) <= radiusKm
  );
  if (eligible.length === 0) return null;

  // A tile is 2-3 km across and the radius is often a few hundred metres, so a
  // landmark near a tile edge loses whatever coverage falls in the neighbour.
  // Accepted rather than fixed by fetching four tiles: it costs some candidates
  // at the margin, and the index has far more landmarks than the pool needs.
  return shuffle(eligible)[0];
}

// -------------------------------------------------------------- mapillary io

/**
 * Finds a 360 panorama near a seed city.
 *
 * The bbox size has to adapt. Mapillary's documented "under 0.01 square
 * degrees" rule is not the binding constraint - a server-side data volume
 * limit is, and it returns HTTP 500 long before the documented cap in dense
 * cities. Density spans orders of magnitude (central Berlin fails even at
 * 0.0003 degrees; a quiet town is fine at 0.08), so the box halves on a volume
 * error and doubles on an empty result, converging on what the area can serve.
 * `boxState` carries that convergence across seeds in the same region so the
 * cost is paid once, not per city.
 */
async function findPanorama(city, config, token, boxState) {
  const { jitterDegrees, imagesPerQuery, graphUrl, imageFields } = config.mapillary;
  const { minSearchBoxDegrees, maxSearchBoxDegrees, maxProbesPerSeed } = config.mapillary;
  const { cameraTypes, minCapturedYear } = config.filters;

  // Offset off the exact city centre so the pool is not all main squares.
  const lat = city.lat + (Math.random() - 0.5) * 2 * jitterDegrees;
  const lon = city.lon + (Math.random() - 0.5) * 2 * jitterDegrees;

  for (let probe = 0; probe < maxProbesPerSeed; probe++) {
    const half = boxState.box / 2;
    const bbox = [lon - half, lat - half, lon + half, lat + half].join(',');
    // is_pano=true filters SERVER-side, so every image returned is a 360.
    // Measured in central Amsterdam: 263 panoramas per request versus 24
    // unfiltered at the same box size, because the unfiltered response spends
    // ~80% of its quota on perspective and fisheye images that get discarded.
    // It also removes the dead end where a box returns a full page of images
    // and not one panorama among them, which abandoned the seed entirely.
    // It does NOT relieve the data-volume limit - both still 500 at the same
    // box size - so the adaptive box below is still doing real work.
    const url =
      `${graphUrl}/images?bbox=${bbox}` +
      `&fields=${imageFields.join(',')}&limit=${imagesPerQuery}` +
      (config.mapillary.serverSidePanoFilter ? '&is_pano=true' : '');

    let response;
    try {
      response = await fetch(url, { headers: { Authorization: `OAuth ${token}` } });
    } catch (error) {
      warn(`Mapillary network error: ${error.message}`);
      return null;
    }

    if (response.status === 429) {
      warn('rate limited by Mapillary, backing off 10s');
      await sleep(10_000);
      continue;
    }

    if (!response.ok) {
      // Too much data for this box. Shrink, or give up if already at the floor.
      if (boxState.box <= minSearchBoxDegrees) return null;
      boxState.box = Math.max(minSearchBoxDegrees, boxState.box / 2);
      await sleep(config.mapillary.requestDelayMs);
      continue;
    }

    const payload = await response.json();
    const images = payload.data ?? [];

    if (images.length === 0) {
      // Sparse here. Widen, or give up if already at the ceiling.
      if (boxState.box >= maxSearchBoxDegrees) return null;
      boxState.box = Math.min(maxSearchBoxDegrees, boxState.box * 2);
      await sleep(config.mapillary.requestDelayMs);
      continue;
    }

    const candidates = images.filter(
      (image) =>
        cameraTypes.includes(image.camera_type) &&
        new Date(image.captured_at ?? 0).getUTCFullYear() >= minCapturedYear &&
        (image.computed_geometry?.coordinates || image.geometry?.coordinates)
    );

    // Images here but no panoramas: a wider box would mostly add more
    // perspective shots, so move on to a different seed instead.
    if (candidates.length === 0) return null;

    const image = shuffle(candidates)[0];
    const [imageLon, imageLat] =
      image.computed_geometry?.coordinates ?? image.geometry.coordinates;

    return {
      id: String(image.id),
      lat: imageLat,
      lon: imageLon,
      capturedAt: new Date(image.captured_at).toISOString().slice(0, 10),
      creator: image.creator?.username ?? 'unknown',
    };
  }

  return null;
}

// --------------------------------------------------------------- geocoding io

async function reverseGeocode(lat, lon, config, contact) {
  const { baseUrl, zoom } = config.geocoding;
  const url = `${baseUrl}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=${zoom}&addressdetails=1`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': `${config.geocoding.userAgentApp} (${contact})`,
      'Accept-Language': 'en',
    },
  });
  if (!response.ok) return null;

  const payload = await response.json();
  const address = payload.address ?? {};

  const pick = (keys) => {
    for (const key of keys) if (address[key]) return address[key];
    return null;
  };

  return {
    countryCode: (address.country_code ?? '').toUpperCase(),
    // Settlement keys only. Falling through to municipality/ward/borough would
    // yield answers like "Metsimaholo Local Municipality" while every distractor
    // is a plain settlement name - the odd one out, pickable without looking at
    // the panorama at all.
    settlement: pick(config.geocoding.settlementKeys),
    region: pick(config.geocoding.regionKeys),
  };
}

// ------------------------------------------------------- place resolution

/**
 * The nearest GeoNames city, but only when it is unambiguously the nearest.
 *
 * A rural panorama still has to answer "which city or town?", and the honest
 * answer is the town it belongs to. That stops being a fair question when two
 * towns are about equally close - the player would be choosing between two
 * defensible answers and only one scores - so a runner-up inside
 * `separationRatio` of the winner disqualifies the location entirely rather
 * than producing a coin flip.
 */
function nearestCityWithMargin(lat, lon, cities, { minPopulation, maxDistanceKm, separationRatio }) {
  // Generous degree box first: haversine over every city for every candidate is
  // the difference between a pass that runs and one that crawls.
  const latPad = maxDistanceKm / 111 + 0.5;
  const lonPad = latPad / Math.max(0.15, Math.cos((lat * Math.PI) / 180));

  let best = null;
  let second = null;
  for (const city of cities) {
    if (city.population < minPopulation) continue;
    if (Math.abs(city.lat - lat) > latPad) continue;
    if (Math.abs(city.lon - lon) > lonPad) continue;

    const km = haversineKm(lat, lon, city.lat, city.lon);
    if (!best || km < best.km) {
      second = best;
      best = { city, km };
    } else if (!second || km < second.km) {
      second = { city, km };
    }
  }

  if (!best || best.km > maxDistanceKm) return null;
  if (second && second.km < best.km * separationRatio) return null;
  return best;
}

/**
 * Turns a candidate panorama and the GeoNames city it will be answered as into
 * a cache entry, or null when the answer would not be honest.
 *
 * Shared by all three passes so they cannot drift: whatever seeded a location -
 * a city, a landmark, or a random point on the coverage graph - the country,
 * region and city it is answered with are verified the same way.
 */
async function buildEntry({
  panorama,
  city,
  config,
  reference,
  contact,
  adminSuffix,
  maxCityDistanceKm,
  preferSeedCityName = false,
}) {
  const { admin1, countryNames, continentOf } = reference;

  if (haversineKm(panorama.lat, panorama.lon, city.lat, city.lon) > maxCityDistanceKm) return null;

  const regionName = admin1.byKey.get(`${city.country}.${city.admin1}`);
  const countryName = countryNames.get(city.country);
  const continent = continentOf.get(city.country);
  if (!regionName || !countryName || !continent) return null;

  let cityName = city.name;
  if (config.geocoding.verifyWithNominatim) {
    await sleep(config.geocoding.rateLimitMs);
    let geo;
    try {
      geo = await reverseGeocode(panorama.lat, panorama.lon, config, contact);
    } catch (error) {
      warn(`Nominatim request failed: ${error.message}`);
      return null;
    }
    if (!geo) return null;
    // A border crossing invalidates both the country and region answers.
    if (geo.countryCode !== city.country) return null;
    if (geo.region && normalizeName(geo.region) !== normalizeName(regionName)) return null;

    // Prefer Nominatim's settlement name, which is the most accurate statement
    // of where the panorama actually is - except out in the country, where the
    // most accurate name is usually a hamlet that GeoNames has never heard of,
    // while every distractor is a town of 15,000 or more. An answer nobody
    // could recognise among four that they might is not a harder question, just
    // an unanswerable one, so a rural location is answered with the town it is
    // nearest to and keeps answer and distractors in one namespace.
    const settlement =
      geo.settlement && !adminSuffix.test(geo.settlement) ? geo.settlement : null;
    if (!preferSeedCityName) cityName = settlement ?? city.name;
  }

  return {
    id: panorama.id,
    lat: Number(panorama.lat.toFixed(5)),
    lon: Number(panorama.lon.toFixed(5)),
    capturedAt: normalizeCapturedAt(panorama.capturedAt),
    creator: panorama.creator,
    // Both kept: the raw heading is what the tile gave, the computed one is
    // Mapillary's structure-from-motion correction and is what gets used.
    compassAngle: panorama.compassAngle ?? null,
    computedCompassAngle: panorama.computedCompassAngle ?? null,
    countryCode: city.country,
    admin1Code: city.admin1,
    answer: {
      continent,
      country: countryName,
      region: regionName,
      city: cityName,
    },
  };
}

// ------------------------------------------------------------- distractors

function pickDistractors(pool, answer, count) {
  const answerKey = normalizeName(answer);
  const unique = [...new Set(pool)].filter((value) => normalizeName(value) !== answerKey);
  return shuffle(unique).slice(0, count);
}

function buildDistractors(entry, reference, config) {
  const { count, widenWhenInsufficient } = config.distractors;
  const { countryNames, admin1, cities, continentOf } = reference;
  const widened = [];

  // Countries: other countries on the same continent.
  const continentPeers = [...countryNames.entries()]
    .filter(([code]) => continentOf.get(code) === entry.answer.continent)
    .map(([, name]) => name);
  let countryOptions = pickDistractors(continentPeers, entry.answer.country, count);
  if (countryOptions.length < count && widenWhenInsufficient) {
    countryOptions = pickDistractors([...countryNames.values()], entry.answer.country, count);
    widened.push('country');
  }

  // Regions: other admin1 regions in the same country.
  const regionPeers = admin1.byCountry.get(entry.countryCode) ?? [];
  let regionOptions = pickDistractors(regionPeers, entry.answer.region, count);
  if (regionOptions.length < count && widenWhenInsufficient) {
    const continentRegions = [...admin1.byCountry.entries()]
      .filter(([code]) => continentOf.get(code) === entry.answer.continent)
      .flatMap(([, names]) => names);
    regionOptions = pickDistractors(continentRegions, entry.answer.region, count);
    widened.push('region');
  }

  // Cities: other cities in the same admin1, then the same country.
  const sameAdmin1 = cities
    .filter((c) => c.country === entry.countryCode && c.admin1 === entry.admin1Code)
    .map((c) => c.name);
  let cityOptions = pickDistractors(sameAdmin1, entry.answer.city, count);
  if (cityOptions.length < count && widenWhenInsufficient) {
    const sameCountry = cities
      .filter((c) => c.country === entry.countryCode)
      .map((c) => c.name);
    cityOptions = pickDistractors(sameCountry, entry.answer.city, count);
    widened.push('city');
  }

  return {
    options: { country: countryOptions, region: regionOptions, city: cityOptions },
    widened,
  };
}

// ----------------------------------------------------------------- streets

/**
 * The street the panorama stands on, from a second Nominatim call.
 *
 * Deliberately separate from the verification call, which runs at zoom 12 and
 * returns no `road` key at all - the design note claimed it came free on the
 * existing request, and it does not. Raising the existing call's zoom instead
 * would change which address keys come back and silently re-tune the city
 * answers, so this is its own request and the tier costs one extra geocode.
 */
async function fetchStreetName(lat, lon, config, contact) {
  const { baseUrl } = config.geocoding;
  const url = `${baseUrl}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=${config.street.nominatimZoom}&addressdetails=1`;

  // Deliberately NO Accept-Language, unlike the verification call above.
  //
  // With `en` Nominatim answers with `name:en` where OSM has one, and Overpass
  // answers with the `name` tag - two namespaces, and the tier breaks in both
  // directions. In Kyiv the answer came back "Kyyevo-Myrotska Street" while one
  // distractor was "Києво-Мироцька вулиця": the same street, so a player picking
  // the right one was marked wrong. In Luxor an English answer sat among four
  // Arabic distractors and was the visual odd one out, pickable without ever
  // looking at the panorama - exactly what settlementKeys exists to prevent for
  // the city tier.
  //
  // The local name is also simply the correct answer here. This is the tier a
  // player solves by finding a street sign, and the sign says the local name.
  const response = await fetch(url, {
    headers: { 'User-Agent': `${config.geocoding.userAgentApp} (${contact})` },
  });
  if (!response.ok) return null;

  const address = (await response.json())?.address ?? {};
  const road = address.road ?? address.pedestrian ?? address.footway ?? null;
  return typeof road === 'string' && road.trim() ? road.trim() : null;
}

/** A degree box of roughly this radius, which Overpass answers far faster than `around`. */
function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

/**
 * Named streets near each of several points, in ONE query.
 *
 * Two things forced this shape, both measured rather than assumed. A
 * per-location `way(around:250,...)` took 22 seconds where the equivalent bbox
 * took 0.35, because `around` computes distances while a bbox uses the spatial
 * index directly. And issuing one request per location - 1,090 of them for this
 * pool - got the IP blocked outright by the main instance before 5% of the
 * sweep was done, which is the API telling you the access pattern is wrong
 * rather than a problem to retry around.
 *
 * A batched query returns a flat union, so each way is asked for its `center`
 * and assigned back to whichever points it is near, here rather than by asking
 * the server again.
 *
 * Returns an array parallel to `points`, or null when every instance refused -
 * which is "unknown", never "this location has no streets". Recording a
 * throttle as a missing street would convert a transient failure into a
 * permanently smaller pool.
 */
async function fetchStreetsForBatch(points, radiusM, config, contact) {
  const { overpassUrls, overpassTimeoutS, maxRetries, retryDelayMs, centreAssignFactor } =
    config.street;

  const boxes = points.map((p) => bboxAround(p.lat, p.lon, radiusM));
  const query =
    `[out:json][timeout:${overpassTimeoutS}];(` +
    boxes.map((b) => `way(${b.map((v) => v.toFixed(6)).join(',')})[highway][name];`).join('') +
    `);out tags center;`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Instances throttle independently, so a refusal is a reason to ask a
    // different one before it is a reason to wait.
    const url = overpassUrls[(attempt - 1) % overpassUrls.length];
    let body;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': `${config.geocoding.userAgentApp} (${contact})`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      body = await response.text();
    } catch (error) {
      warn(`Overpass network error at ${new URL(url).host} (${attempt}/${maxRetries}): ${error.message}`);
      await sleep(retryDelayMs);
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      warn(
        `Overpass at ${new URL(url).host} returned non-JSON (${attempt}/${maxRetries}): ` +
          `${(body.slice(0, 60) || '<empty>').replace(/\s+/g, ' ').trim()}`
      );
      await sleep(retryDelayMs);
      continue;
    }

    const perPoint = points.map(() => new Set());
    const reach = (radiusM * centreAssignFactor) / 1000;

    for (const element of payload.elements ?? []) {
      const name = element?.tags?.name;
      const centre = element?.center;
      if (typeof name !== 'string' || !name.trim() || !centre) continue;

      points.forEach((point, index) => {
        if (haversineKm(centre.lat, centre.lon, point.lat, point.lon) <= reach) {
          perPoint[index].add(name.trim());
        }
      });
    }

    return perPoint.map((set) => [...set]);
  }

  return null;
}

/**
 * Fills in the street answer and its distractors for every cached location that
 * does not have them yet.
 *
 * An enrichment pass rather than a discovery one: it adds a field to locations
 * the other passes already found, and it is resumable in the same way, writing
 * the cache after each location.
 *
 * `streetChecked` is set only when the lookup actually returned an answer -
 * including the answer "there is no named road here", which is a real finding.
 * A rate-limited request leaves the flag unset so a later run retries it,
 * because caching a throttle as a missing street would turn a transient failure
 * into a permanently smaller pool.
 */
async function runStreetPass(ctx) {
  const { args, config, accepted, contact } = ctx;
  const settings = config.street;
  const writeCache = () =>
    fs.writeFile(ctx.cachePath, JSON.stringify({ accepted }, null, 2));

  // Two phases, because the two services want opposite access patterns.
  // Nominatim answers one point per request at one request per second, so the
  // names come in sequentially. Overpass will answer a dozen boxes in a single
  // query and blocks an IP that asks a thousand times, so the distractors go
  // out in batches.

  // ---- phase 1: the street name, one Nominatim call each ----

  const needName = accepted
    .filter((entry) => !entry.streetNameChecked)
    .slice(0, args.limit ?? Infinity);

  if (needName.length > 0) {
    const outstanding = accepted.filter((entry) => !entry.streetNameChecked).length;
    log(
      `streets: looking up ${needName.length} street names` +
        (needName.length < outstanding ? ` (--limit; ${outstanding} outstanding)` : '')
    );

    let named = 0;
    for (const [index, entry] of needName.entries()) {
      await sleep(config.geocoding.rateLimitMs);
      let road;
      try {
        road = await fetchStreetName(entry.lat, entry.lon, config, contact);
      } catch (error) {
        warn(`Nominatim street lookup failed for ${entry.id}: ${error.message}`);
        continue;
      }

      entry.streetNameChecked = true;
      entry.street = road;
      if (road) {
        named++;
      } else {
        // A real finding rather than a failure: OpenStreetMap has no named road
        // at this point, so there is nothing to ask distractors about either.
        entry.streetChecked = true;
        entry.streetOptions = [];
      }
      await writeCache();

      if ((index + 1) % 50 === 0 || index === needName.length - 1) {
        log(`  streets: ${index + 1}/${needName.length} named, ${named} have a road`);
      }
    }
  }

  // ---- phase 2: four nearby street names each, batched ----

  const needOptions = accepted.filter(
    (entry) => entry.streetNameChecked && entry.street && !entry.streetChecked
  );
  if (needOptions.length === 0) {
    log('streets: nothing left to look up');
    return;
  }

  log(
    `streets: fetching neighbours for ${needOptions.length} roads, batches of ` +
      `${settings.batchSize}, radii ${settings.radiiM.join('/')} m`
  );

  // Names found so far per location. Each radius only re-asks about the
  // locations still short of distractors, so a dense city costs one query and a
  // quiet lane costs three - instead of every location paying for the widest
  // search.
  //
  // Accumulated ON the entry and written after every batch, so an interrupted
  // run resumes with the wider radii already paid for. Holding it only in
  // memory and writing once at the end - which this did at first - throws away
  // the whole sweep if the process is killed, and this sweep takes an hour.
  const found = new Map(needOptions.map((entry) => [entry, [...(entry.streetNearby ?? [])]]));
  const unresolvedEntries = new Set();

  for (const radius of settings.radiiM) {
    const stillShort = needOptions.filter(
      (entry) =>
        !unresolvedEntries.has(entry) &&
        pickDistractors(found.get(entry), entry.street, settings.distractorCount).length <
          settings.distractorCount
    );
    if (stillShort.length === 0) break;

    log(`  streets: ${stillShort.length} still short, asking at ${radius} m`);

    for (let i = 0; i < stillShort.length; i += settings.batchSize) {
      const batch = stillShort.slice(i, i + settings.batchSize);
      await sleep(settings.rateLimitMs);

      const nearby = await fetchStreetsForBatch(batch, radius, config, contact);
      if (nearby === null) {
        // Every instance refused. These stay unresolved rather than being
        // recorded as short: filing a throttled request as a coverage limit is
        // how a transient failure becomes a permanently smaller pool.
        batch.forEach((entry) => unresolvedEntries.add(entry));
        continue;
      }

      batch.forEach((entry, index) => {
        const merged = new Set(found.get(entry));
        for (const name of nearby[index]) merged.add(name);
        found.set(entry, [...merged]);
        entry.streetNearby = found.get(entry);
      });
      await writeCache();
    }
  }

  let withEnough = 0;
  for (const entry of needOptions) {
    if (unresolvedEntries.has(entry)) continue;
    const options = pickDistractors(found.get(entry), entry.street, settings.distractorCount);
    entry.streetChecked = true;
    entry.streetOptions = options;
    // The raw neighbour list has served its purpose; keeping it would triple
    // the size of the cache for nothing.
    delete entry.streetNearby;
    if (options.length >= settings.distractorCount) withEnough++;
  }
  const unresolved = unresolvedEntries.size;
  await writeCache();

  log(
    `streets: ${withEnough} of ${needOptions.length} roads carry ` +
      `${settings.distractorCount} distractors` +
      (unresolved > 0 ? `, ${unresolved} left unresolved for a later run` : '')
  );
}

/**
 * Whether an option stands out from its alternatives by script alone.
 *
 * The street tier had exactly this bug: an English answer among four Arabic
 * distractors in Luxor, and a transliterated one beside its own Cyrillic name in
 * Kyiv. Both were pickable, or unfairly wrong, without ever looking at the
 * panorama - the same failure `settlementKeys` exists to prevent for the city
 * tier, arriving through a different door.
 *
 * Judged on LETTERS only. Testing whole strings flagged
 * "Jalan Tol Pejagan-Pemalang" purely because of its en dash, and a road tagged
 * "3" because a bare number has no script at all - two false positives out of
 * six, in a guard whose whole job is to be worth reading.
 *
 * The root cause is fixed by asking both services for the same name, so this
 * reports rather than drops: an English street name in a mostly-Arabic city
 * genuinely exists, and three of these survive in the West Bank where OSM
 * itself tags neighbouring ways in different scripts.
 */
function isScriptOutlier(answer, distractors) {
  if (distractors.length === 0) return false;
  // Explicit code points rather than literal characters: a stray NUL got into
  // this class as a literal once, which left the file valid JavaScript but made
  // grep treat the whole thing as binary and report every search as no-match -
  // which reads exactly like the code having been deleted.
  const isLetter = (c) => /\p{L}/u.test(c);
  const latin = (value) => {
    const letters = [...value].filter(isLetter);
    return letters.length === 0 ? null : letters.every((c) => /[\u0020-\u024F]/.test(c));
  };

  const answerLatin = latin(answer);
  if (answerLatin === null) return false;
  return distractors.every((d) => {
    const other = latin(d);
    return other !== null && other !== answerLatin;
  });
}

// ------------------------------------------------------------- difficulty

/** Is there a city of at least this size within reach? */
function hasCityWithin(lat, lon, cities, minPopulation, maxDistanceKm) {
  const latPad = maxDistanceKm / 111 + 0.2;
  const lonPad = latPad / Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  for (const city of cities) {
    if (city.population < minPopulation) continue;
    if (Math.abs(city.lat - lat) > latPad || Math.abs(city.lon - lon) > lonPad) continue;
    if (haversineKm(lat, lon, city.lat, city.lon) <= maxDistanceKm) return true;
  }
  return false;
}

/**
 * Which difficulty a location is, decided from where it stands rather than from
 * which pass found it.
 *
 * Easy is "a famous landmark is within the radius its own kind earns", and it
 * carries the bearing to that landmark so the round opens facing it. Medium is
 * "a major city and demonstrably no landmark". Everything else is hard, which
 * includes the deliberately ambiguous band between the two: a panorama 950 m
 * from the Eiffel Tower is neither a landmark round nor a landmark-free one,
 * and hard is the mode that admits everything anyway.
 */
function classifyDifficulty(entry, landmarks, cities, config) {
  const { medium } = config.difficulty;

  // The most famous landmark that is close enough to be the subject, not merely
  // the closest: standing between a chapel and the Eiffel Tower, the round is
  // about the Eiffel Tower.
  let subject = null;
  let inExclusionBand = false;

  for (const landmark of landmarks) {
    const metres = haversineKm(entry.lat, entry.lon, landmark.lat, landmark.lon) * 1000;
    if (metres <= landmark.radiusM) {
      if (!subject || landmark.sitelinks > subject.landmark.sitelinks) {
        subject = { landmark, metres };
      }
    } else if (metres <= landmark.radiusM * medium.landmarkExclusionFactor) {
      inExclusionBand = true;
    }
  }

  if (subject) {
    const result = {
      difficulty: 'easy',
      landmark: subject.landmark.name,
      landmarkDistanceM: Math.round(subject.metres),
    };
    // The computed heading only. The raw compass_angle is frequently a plain
    // 0.0 standing in for "the camera recorded none", and there is no way to
    // tell that from a camera genuinely pointing north - the Arc de Triomphe
    // panorama is one, and trusting it aimed the round 121 degrees away from an
    // arch that was dead ahead. A round that opens straight ahead is a smaller
    // failure than one that opens confidently in the wrong direction, so a
    // location with no computed heading gets no bearing at all.
    if (entry.computedCompassAngle != null) {
      const bearing = bearingDeg(
        entry.lat,
        entry.lon,
        subject.landmark.lat,
        subject.landmark.lon
      );
      result.initialYaw = Math.round(relativeBearing(bearing, entry.computedCompassAngle));
    }
    return result;
  }

  if (inExclusionBand) return { difficulty: 'hard' };

  const metro = hasCityWithin(
    entry.lat,
    entry.lon,
    cities,
    medium.minCityPopulation,
    medium.maxCityDistanceKm
  );
  return { difficulty: metro ? 'medium' : 'hard' };
}

// ------------------------------------------------------------------- passes

/**
 * The original pass: seed on real cities inside each region bbox.
 *
 * Sampling near cities raises the hit rate enormously over sampling a
 * continent-sized box at random, which is why this exists - and also exactly
 * why it cannot produce a rural location, which is what the rural pass is for.
 */
async function runCityPass(ctx) {
  const { args, config, token, cities, accepted, seenIds, excluded, tileCache } = ctx;

  // --limit scales every region proportionally, so a smoke-test pool keeps the
  // same geographic spread as a full one.
  const configuredTotal = config.regions.reduce((sum, r) => sum + r.targetCount, 0);

  for (const region of config.regions) {
    const [minLon, minLat, maxLon, maxLat] = region.bbox;
    const target = args.limit
      ? Math.max(1, Math.round((region.targetCount / configuredTotal) * args.limit))
      : region.targetCount;

    // Counted per pass: rural entries carry a seedRegion too, and letting them
    // fill this quota would quietly shrink the urban pool they were added to.
    const already = accepted.filter(
      (e) => (e.seedPass ?? 'cities') === 'cities' && e.seedRegion === region.name
    ).length;
    if (already >= target) continue;

    // A bbox alone is a leaky definition of a region: the Canada box reaches
    // into the northern US, and the Mexico/Central America box reaches into
    // Florida, so those quotas quietly fill with US locations. An optional
    // per-region country allowlist pins the region to what it actually names.
    const allowed = region.countries ? new Set(region.countries) : null;

    const regionCities = shuffle(
      cities.filter(
        (c) =>
          c.lat >= minLat &&
          c.lat <= maxLat &&
          c.lon >= minLon &&
          c.lon <= maxLon &&
          !excluded.has(c.country) &&
          (!allowed || allowed.has(c.country))
      )
    );

    if (regionCities.length === 0) {
      warn(`${region.name}: no seed cities inside bbox - check the coordinates`);
      continue;
    }

    log(`cities/${region.name}: ${already}/${target} (${regionCities.length} seed cities)`);

    let found = already;
    let attempts = 0;
    const maxAttempts = (target - already) * config.mapillary.maxAttemptsPerAccepted;
    // Per-region so the box converges on this area's density once, not per city.
    // Only used by the legacy bbox discovery mode.
    const boxState = { box: config.mapillary.initialSearchBoxDegrees };

    while (found < target && attempts < maxAttempts) {
      attempts++;
      const city = regionCities[attempts % regionCities.length];

      await sleep(config.mapillary.requestDelayMs);
      let panorama;
      try {
        panorama =
          config.mapillary.discoveryMode === 'tiles'
            ? await findPanoramaViaTiles(city, config, token, tileCache)
            : await findPanorama(city, config, token, boxState);
      } catch (error) {
        warn(`Mapillary request failed: ${error.message}`);
        continue;
      }
      if (!panorama || seenIds.has(panorama.id)) continue;

      // Keep the pool spread out so one street cannot appear twice in a match.
      if (isTooClose(panorama, accepted, config.filters.minSeparationKm)) continue;

      const entry = await buildEntry({
        panorama,
        city,
        config,
        reference: ctx.reference,
        contact: ctx.contact,
        adminSuffix: ctx.adminSuffix,
        maxCityDistanceKm: config.filters.maxCityDistanceKm,
      });
      if (!entry) continue;

      if (!entry.creator) {
        await sleep(config.mapillary.requestDelayMs);
        const meta = await fetchImageAttribution(entry.id, config, token);
        entry.creator = meta.creator;
        entry.computedCompassAngle = meta.computedCompassAngle;
      }

      entry.seedPass = 'cities';
      entry.seedRegion = region.name;
      await recordEntry(ctx, entry);
      found++;

      // Report what this mode actually did. Printing the adaptive box size in
      // tile mode would be describing machinery that never ran.
      const how =
        config.mapillary.discoveryMode === 'tiles'
          ? `tile z${config.mapillary.tileZoom}, ${tileCache.size} cached`
          : `box ${boxState.box.toFixed(4)}°`;
      log(
        `  cities/${region.name}: ${found}/${target} — ${entry.answer.city}, ` +
          `${entry.answer.country} (${how}, ${attempts} attempts)`
      );
    }

    if (found < target) {
      warn(`cities/${region.name}: stopped at ${found}/${target} after ${attempts} attempts`);
    }
  }
}

/**
 * Seeds on landmark coordinates, which is the only direction that produces an
 * easy pool.
 *
 * Filtering the city-seeded pool for visible landmarks would return
 * approximately nothing - panoramas beside world-famous landmarks are a
 * vanishingly small fraction of Mapillary - so this inverts the search and
 * starts from the landmark.
 */
async function runLandmarkPass(ctx) {
  const { args, config, token, landmarks, cities, accepted, seenIds, excluded } = ctx;
  const settings = config.difficulty.easy;

  const target = args.limit
    ? Math.max(
        1,
        Math.round(
          (settings.targetCount / config.regions.reduce((s, r) => s + r.targetCount, 0)) *
            args.limit
        )
      )
    : settings.targetCount;

  const already = accepted.filter((e) => e.seedPass === 'landmarks').length;
  if (already >= target) return;

  // Shuffled rather than taken most-famous-first: the top of the index is
  // heavily European, and a pool that is 90% Paris and Rome would make easy
  // mode a European mode. The index carries no country - excluded countries are
  // enforced below, against the GeoNames city the location resolves to.
  const queue = shuffle(landmarks);
  const perCountry = new Map();
  for (const entry of accepted.filter((e) => e.seedPass === 'landmarks')) {
    perCountry.set(entry.countryCode, (perCountry.get(entry.countryCode) ?? 0) + 1);
  }

  log(`landmarks: ${already}/${target} (${queue.length} landmarks in the index)`);

  const tileCache = new Map();
  let found = already;
  let attempts = 0;
  const maxAttempts = (target - already) * settings.maxAttemptsPerAccepted;

  for (const landmark of queue) {
    if (found >= target || attempts >= maxAttempts) break;
    attempts++;

    await sleep(config.mapillary.requestDelayMs);
    let panorama;
    try {
      panorama = await findPanoramaNearLandmark(landmark, config, token, tileCache);
    } catch (error) {
      warn(`Mapillary request failed: ${error.message}`);
      continue;
    }
    if (!panorama || seenIds.has(panorama.id)) continue;

    // Landmarks cluster, so the pool-wide separation would allow one easy
    // location per neighbourhood. Two panoramas 400 m apart facing different
    // landmarks are different rounds.
    if (isTooClose(panorama, accepted, settings.minSeparationKm)) continue;

    // The landmark supplies the position; a GeoNames city still has to supply
    // the country and region codes the answer and its distractors are built from.
    const nearest = nearestCityWithMargin(panorama.lat, panorama.lon, cities, {
      minPopulation: config.filters.minCityPopulation,
      maxDistanceKm: config.filters.maxCityDistanceKm,
      separationRatio: 1,
    });
    if (!nearest || excluded.has(nearest.city.country)) continue;

    const capped = perCountry.get(nearest.city.country) ?? 0;
    if (capped >= settings.maxPerCountry) continue;

    const entry = await buildEntry({
      panorama,
      city: nearest.city,
      config,
      reference: ctx.reference,
      contact: ctx.contact,
      adminSuffix: ctx.adminSuffix,
      maxCityDistanceKm: config.filters.maxCityDistanceKm,
    });
    if (!entry) continue;

    if (!entry.creator) {
      await sleep(config.mapillary.requestDelayMs);
      const meta = await fetchImageAttribution(entry.id, config, token);
      entry.creator = meta.creator;
      entry.computedCompassAngle = meta.computedCompassAngle;
    }

    entry.seedPass = 'landmarks';
    entry.seedLandmark = landmark.name;
    await recordEntry(ctx, entry);
    perCountry.set(entry.countryCode, capped + 1);
    found++;

    const metres = Math.round(
      haversineKm(entry.lat, entry.lon, landmark.lat, landmark.lon) * 1000
    );
    log(
      `  landmarks: ${found}/${target} — ${landmark.name} (${metres} m, ` +
        `${entry.answer.city}, ${entry.answer.country}, ${attempts} attempts)`
    );
  }

  if (found < target) {
    warn(
      `landmarks: stopped at ${found}/${target} after ${attempts} attempts. ` +
        'Mapillary has no 360 coverage beside most landmarks; lower easy.targetCount ' +
        'or minSitelinks in config/landmark-config.json to widen the index.'
    );
  }
}

/**
 * Samples the coverage graph itself, which is what makes hard mode honestly
 * "anywhere".
 *
 * Every other pass seeds on a settlement, so every location it can produce is
 * urban or near-urban - "could be anywhere, urban or rural" was a promise the
 * pool could not keep. Sampling random points over a region bbox does not work
 * either: coverage follows roads, so almost every random point has nothing
 * near it. The coverage tile solves it, because a sequence line IS a statement
 * that imagery exists there.
 */
async function runRuralPass(ctx) {
  const { args, config, token, cities, accepted, seenIds, excluded } = ctx;
  const settings = config.difficulty.rural;

  // One per region under --limit. Scaling the quota proportionally, as the
  // other passes do, would make a smoke test slower than the pass it is meant
  // to be smoke-testing: a coarse tile is several megabytes.
  const target = args.limit ? 1 : settings.targetCountPerRegion;

  const tileCache = new Map();

  for (const region of config.regions) {
    const [minLon, minLat, maxLon, maxLat] = region.bbox;
    const already = accepted.filter(
      (e) => e.seedPass === 'rural' && e.seedRegion === region.name
    ).length;
    if (already >= target) continue;

    const allowed = region.countries ? new Set(region.countries) : null;
    log(`rural/${region.name}: ${already}/${target}`);

    let found = already;
    let attempts = 0;
    const maxAttempts = (target - already) * settings.maxAttemptsPerAccepted;

    while (found < target && attempts < maxAttempts) {
      attempts++;

      // A random tile inside the region, at a zoom coarse enough that most
      // tiles with any coverage at all will have some.
      const z = settings.sampleZoom;
      const last = 2 ** z - 1;
      const corner = lonLatToTile(minLon, maxLat, z);
      const far = lonLatToTile(maxLon, minLat, z);
      // Clamped: a bbox reaching exactly 180° longitude - the Pacific region
      // does - lands one tile past the edge of the grid and 404s every time.
      const x = Math.min(
        last,
        corner.x + Math.floor(Math.random() * Math.max(1, far.x - corner.x + 1))
      );
      const y = Math.min(
        last,
        corner.y + Math.floor(Math.random() * Math.max(1, far.y - corner.y + 1))
      );
      const key = `${z}/${x}/${y}`;

      let sequences = tileCache.get(key);
      if (!sequences) {
        await sleep(config.mapillary.requestDelayMs);
        try {
          sequences = await fetchTileSequences(z, x, y, config, token);
        } catch (error) {
          warn(`Mapillary tile request failed: ${error.message}`);
          continue;
        }
        // A coarse tile is several megabytes, so the cache is deliberately tiny.
        if (tileCache.size >= settings.tileCacheSize) {
          tileCache.delete(tileCache.keys().next().value);
        }
        tileCache.set(key, sequences);
      }
      if (sequences.length === 0) continue;

      for (const imageId of shuffle(sequences).slice(0, settings.candidatesPerTile)) {
        if (found >= target) break;
        if (seenIds.has(imageId)) continue;

        await sleep(config.mapillary.requestDelayMs);
        let panorama;
        try {
          panorama = await fetchImageMeta(imageId, config, token);
        } catch (error) {
          warn(`Mapillary request failed: ${error.message}`);
          continue;
        }
        if (!panorama) continue;
        if (new Date(panorama.capturedAt).getUTCFullYear() < config.filters.minCapturedYear) {
          continue;
        }
        if (isTooClose(panorama, accepted, config.filters.minSeparationKm)) continue;

        const nearest = nearestCityWithMargin(panorama.lat, panorama.lon, cities, {
          minPopulation: config.filters.minCityPopulation,
          maxDistanceKm: settings.maxCityDistanceKm,
          separationRatio: settings.separationRatio,
        });
        if (!nearest) continue;
        if (excluded.has(nearest.city.country)) continue;
        if (allowed && !allowed.has(nearest.city.country)) continue;

        const entry = await buildEntry({
          panorama,
          city: nearest.city,
          config,
          reference: ctx.reference,
          contact: ctx.contact,
          adminSuffix: ctx.adminSuffix,
          maxCityDistanceKm: settings.maxCityDistanceKm,
          // Out here Nominatim's settlement is usually a hamlet GeoNames has
          // never heard of, while every distractor is a town of 15,000+.
          preferSeedCityName: true,
        });
        if (!entry) continue;

        entry.seedPass = 'rural';
        entry.seedRegion = region.name;
        await recordEntry(ctx, entry);
        found++;

        log(
          `  rural/${region.name}: ${found}/${target} — ${entry.answer.city}, ` +
            `${entry.answer.country} (${nearest.km.toFixed(1)} km out, tile z${z}, ` +
            `${attempts} tiles)`
        );
      }
    }

    if (found < target) {
      warn(`rural/${region.name}: stopped at ${found}/${target} after ${attempts} tiles`);
    }
  }
}

/**
 * Fetches the compass angle for locations that classify as easy but do not
 * carry one.
 *
 * These are locations found before compass_angle was read from the tile, which
 * happen to stand next to a landmark - the classification is uniform, so a
 * city-seeded panorama under the Colosseum becomes an easy location without
 * ever having been sought as one. Without a heading there is no way to say
 * where in the image the landmark falls, and the round would open pointing
 * anywhere, which is the one thing easy mode promises beyond proximity.
 *
 * Bounded by how many such locations exist, and it only ever runs once each:
 * the answer is written back to the cache.
 */
async function backfillCompassAngles(ctx) {
  const { config, token, accepted, landmarks, cities } = ctx;

  // `computedCompassChecked` stops this asking again about the handful of
  // images Mapillary simply has no computed heading for. Without it every run
  // re-fetches the same failures forever.
  const missing = accepted.filter(
    (entry) =>
      entry.computedCompassAngle == null &&
      !entry.computedCompassChecked &&
      classifyDifficulty(entry, landmarks, cities, config).difficulty === 'easy'
  );
  if (missing.length === 0) return;

  log(`backfilling computed compass angles for ${missing.length} easy locations`);
  let filled = 0;

  for (const entry of missing) {
    await sleep(config.mapillary.requestDelayMs);
    let meta;
    try {
      meta = await fetchImageAttribution(entry.id, config, token);
    } catch (error) {
      warn(`compass backfill failed for ${entry.id}: ${error.message}`);
      continue;
    }
    if (meta == null) continue;
    // Asked and answered, even when the answer is "there isn't one".
    entry.computedCompassChecked = true;
    if (meta.computedCompassAngle == null) continue;
    entry.computedCompassAngle = meta.computedCompassAngle;
    filled++;
  }

  await fs.writeFile(ctx.cachePath, JSON.stringify({ accepted }, null, 2));
  log(`backfilled ${filled}/${missing.length} compass angles`);
}

/** Keep the pool spread out so one street cannot appear twice in a match. */
function isTooClose(panorama, accepted, minSeparationKm) {
  return accepted.some(
    (e) => haversineKm(e.lat, e.lon, panorama.lat, panorama.lon) < minSeparationKm
  );
}

/**
 * Accept an entry and persist the cache.
 *
 * Written on every accept rather than in batches: the manifest is only emitted
 * at the very end, so a long run killed halfway would otherwise strand
 * everything it found.
 */
async function recordEntry(ctx, entry) {
  ctx.accepted.push(entry);
  ctx.seenIds.add(entry.id);
  await fs.writeFile(ctx.cachePath, JSON.stringify({ accepted: ctx.accepted }, null, 2));
}

// ---------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await loadEnv();

  const token = process.env.MAPILLARY_TOKEN;
  if (!token) {
    console.error(
      'MAPILLARY_TOKEN is not set. Run `op inject -i .env.tpl -o .env`, or export it.\n' +
        'Create a free token at https://www.mapillary.com/dashboard/developers'
    );
    process.exit(1);
  }
  const contact = process.env.NOMINATIM_CONTACT || 'wanderguess';

  const config = await readJson('config/pool-config.json');
  const continentsConfig = await readJson('config/continents.json');

  const continentOf = new Map();
  for (const [continent, codes] of Object.entries(continentsConfig.continents)) {
    for (const code of codes) continentOf.set(code, continent);
  }

  // Settlement values carrying an administrative suffix are rejected in favour
  // of the GeoNames seed city; see geocoding._adminSuffixComment.
  const adminSuffix = new RegExp(config.geocoding.adminSuffixPattern, 'i');

  const files = await ensureGeonames(config);
  const [cities, admin1, countryNames] = await Promise.all([
    parseCities(files.citiesTxt, config.filters.minCityPopulation),
    parseAdmin1(files.admin1Txt),
    parseCountries(files.countryTxt),
  ]);
  log(`reference data: ${cities.length} cities, ${countryNames.size} countries`);

  const cachePath = path.join(PROJECT_ROOT, config.output.cachePath);
  let cache = { accepted: [] };
  if (!args.force && (await exists(cachePath))) {
    cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    log(`resuming from cache with ${cache.accepted.length} locations`);
  }

  const accepted = cache.accepted;
  const seenIds = new Set(accepted.map((e) => e.id));
  const excluded = new Set(config.filters.excludeCountries);
  // Shared across regions: adjacent seed cities often fall in the same tile.
  const tileCache = new Map();

  const reference = { countryNames, admin1, cities, continentOf };

  // Built (or loaded) before any pass runs, because two of the three need it:
  // the landmark pass seeds on it, and classification asks it about every
  // location regardless of which pass found that location.
  const landmarks = await ensureLandmarkIndex({ force: false, contact });

  const ctx = {
    args,
    config,
    token,
    contact,
    cities,
    landmarks,
    accepted,
    seenIds,
    excluded,
    tileCache,
    cachePath,
    reference,
    adminSuffix,
  };

  // --emit-only turns whatever is already cached into a manifest without
  // contacting Mapillary. The discovery loop writes the cache continuously but
  // the manifest only at the end, so stopping a long run early would otherwise
  // strand every accepted location in a cache no part of the game reads. It is
  // also how a classification change is applied to an existing pool.
  if (args.emitOnly) {
    log(`--emit-only: building a manifest from ${accepted.length} cached locations`);
  } else {
    const runners = {
      cities: runCityPass,
      landmarks: runLandmarkPass,
      rural: runRuralPass,
      streets: runStreetPass,
    };
    for (const pass of args.passes) {
      log(`=== pass: ${pass} ===`);
      await runners[pass](ctx);
      await fs.writeFile(cachePath, JSON.stringify({ accepted }, null, 2));
    }
    // After the passes, because a pass can turn an existing location into an
    // easy one by putting a landmark nowhere near it - classification is about
    // the place, not about which pass ran.
    await backfillCompassAngles(ctx);
  }

  // ---- classify, bake distractors and emit ----

  const widenedCounts = {};
  const locations = [];
  const byDifficulty = { easy: 0, medium: 0, hard: 0 };
  let easyWithoutBearing = 0;
  let noStreetName = 0;
  let tooFewStreetOptions = 0;
  let streetUnchecked = 0;
  let scriptOutliers = 0;
  let designationAnswers = 0;
  const rejectAnswer = new RegExp(config.street.rejectAnswerPattern);

  for (const entry of accepted) {
    const { options, widened } = buildDistractors(entry, reference, config);
    for (const tier of widened) widenedCounts[tier] = (widenedCounts[tier] ?? 0) + 1;

    // A tier with no distractors would hand out free points; drop the entry.
    if (!options.country.length || !options.region.length || !options.city.length) continue;

    // The street tier is required, not optional. Every other rule in this game
    // exists to make turns worth the same, and a location dealt with a shorter
    // ladder would be worth 10 where the next player's is worth 15 - unfair in
    // exactly the way the scope rules are careful never to be. So a location
    // without a named road, or without enough named neighbours to ask about it,
    // costs coverage instead.
    if (!entry.streetChecked) {
      streetUnchecked++;
      continue;
    }
    if (!entry.street) {
      noStreetName++;
      continue;
    }
    options.street = entry.streetOptions ?? [];
    if (options.street.length < config.street.distractorCount) {
      tooFewStreetOptions++;
      continue;
    }
    // "I 80" or "BR-153" is a route designation, not a street name, and it sits
    // among four named streets as the obvious odd one out.
    if (rejectAnswer.test(entry.street.trim())) {
      designationAnswers++;
      continue;
    }
    if (isScriptOutlier(entry.street, options.street)) scriptOutliers++;

    const classification = classifyDifficulty(entry, landmarks, cities, config);
    byDifficulty[classification.difficulty]++;
    if (classification.difficulty === 'easy' && classification.initialYaw == null) {
      easyWithoutBearing++;
    }

    locations.push({
      id: entry.id,
      lat: entry.lat,
      lon: entry.lon,
      capturedAt: normalizeCapturedAt(entry.capturedAt),
      creator: entry.creator,
      difficulty: classification.difficulty,
      ...(classification.landmark ? { landmark: classification.landmark } : {}),
      ...(classification.initialYaw != null ? { initialYaw: classification.initialYaw } : {}),
      answer: { ...entry.answer, street: entry.street },
      options,
    });
  }

  const manifest = {
    version: config.version,
    generatedAt: new Date().toISOString(),
    count: locations.length,
    // Sorted, NOT shuffled. `selectMatchLocations` already shuffles the pool at
    // play time, so shuffling here changed nothing about the game and made
    // every rebuild a maximal diff - 11,583 lines added and 11,583 removed for
    // a manifest whose contents had not changed at all. A stable order means a
    // rebuild's diff is the locations that actually came and went.
    locations: [...locations].sort((a, b) => a.id.localeCompare(b.id)),
  };

  const manifestPath = path.join(PROJECT_ROOT, config.output.manifestPath);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  log(`wrote ${locations.length} locations to ${config.output.manifestPath}`);
  if (locations.length !== accepted.length) {
    warn(`${accepted.length - locations.length} of ${accepted.length} entries dropped`);
  }
  // Itemised rather than lumped into one number, because these are the cost of
  // requiring the street tier and the whole point of measuring was to see it.
  if (noStreetName > 0) warn(`  ${noStreetName} have no named road in OpenStreetMap`);
  if (tooFewStreetOptions > 0) {
    warn(
      `  ${tooFewStreetOptions} have a named road but fewer than ` +
        `${config.street.distractorCount} named neighbours to ask about it`
    );
  }
  if (streetUnchecked > 0) {
    warn(
      `  ${streetUnchecked} were never looked up - run \`--pass streets\` to recover them, ` +
        'they are not a coverage limit'
    );
  }
  if (designationAnswers > 0) {
    warn(
      `  ${designationAnswers} have a route designation ("I 80", "BR-153") rather than a ` +
        'street name, which is the odd one out among named distractors'
    );
  }
  if (scriptOutliers > 0) {
    // Not fatal, but a spike here means the street answer and its distractors
    // have drifted into different namespaces again.
    warn(
      `${scriptOutliers} street answers are in a different script from every one of ` +
        'their distractors, which is pickable without looking at the panorama'
    );
  }
  for (const [tier, count] of Object.entries(widenedCounts)) {
    warn(`${count} ${tier} distractor sets were widened beyond the ideal scope`);
  }

  log('coverage by difficulty:', byDifficulty);
  if (easyWithoutBearing > 0) {
    // These still play; they just open straight ahead instead of facing the
    // landmark, which is the one thing easy mode promises beyond proximity.
    warn(
      `${easyWithoutBearing} easy locations open straight ahead rather than facing ` +
        'their landmark, because Mapillary has no computed_compass_angle for them. ' +
        'Deliberate: the raw compass_angle is often a stand-in 0.0, and a round that ' +
        'opens confidently in the wrong direction is worse than one that does not turn.'
    );
  }

  const byContinent = {};
  for (const location of locations) {
    byContinent[location.answer.continent] =
      (byContinent[location.answer.continent] ?? 0) + 1;
  }
  log('coverage by continent:', byContinent);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
