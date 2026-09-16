#!/usr/bin/env node
/**
 * Builds the landmark index easy and medium mode are seeded from.
 *
 * Easy mode promises a famous landmark in view, and medium mode promises the
 * opposite - a major city with nothing iconic to give it away. Both need the
 * same thing: a list of world-famous landmarks with coordinates. One index,
 * used with the sign flipped.
 *
 * Landmarks come from Wikidata, which is free and needs no key, ranked by
 * sitelink count: an item carried by 40+ language editions of Wikipedia is
 * world-famous by construction, so nobody has to curate a list by hand.
 *
 * Everything tunable lives in config/landmark-config.json.
 *
 * Usage:
 *   node scripts/build-landmark-index.mjs           # reuse the cached index
 *   node scripts/build-landmark-index.mjs --force   # requery Wikidata
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log('[landmarks]', ...args);
const warn = (...args) => console.warn('[landmarks]', ...args);

/**
 * Every item of one class that has coordinates and enough sitelinks.
 *
 * One class per query is not a style choice. `wdt:P31/wdt:P279* wd:Q811979`
 * (architectural structure) is millions of items and times out the public query
 * service every time; the same query against `wd:Q12518` (tower) returns in
 * about a second. The class list in config is what makes this tractable.
 */
function classQuery(classId, minSitelinks) {
  return `
SELECT ?item ?itemLabel ?coord ?sitelinks WHERE {
  ?item wdt:P31/wdt:P279* wd:${classId} ;
        wdt:P625 ?coord ;
        wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${minSitelinks})
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

/**
 * Which of these items are also a settlement, an administrative unit or a
 * region - and therefore not a landmark at all.
 *
 * Bound with VALUES so the query starts from the items rather than walking a
 * class tree, which is what keeps it fast enough to return. Without this step
 * "archaeological site" alone contributes Athens, Cairo, Damascus, Cologne and
 * Alexandria, each with a coordinate at the city centre, and easy mode would
 * name the city as the landmark for the city it is asking the player to guess.
 *
 * The FILTER is what keeps this from overshooting. It tests each P31 class
 * individually rather than the item as a whole, and spares any class that is
 * also an architectural structure - because a few classes are honestly both.
 * Prague Castle is a "hillfort" and the Acropolis of Athens is an "acropolis",
 * and both descend from fortified settlement; without the FILTER they leave
 * with Athens. "City" is not an architectural structure, so Athens still goes.
 */
function exclusionQuery(itemIds, config) {
  return `
SELECT DISTINCT ?item WHERE {
  VALUES ?item { ${itemIds.map((id) => `wd:${id}`).join(' ')} }
  VALUES ?root { ${config.excludeRoots.map((r) => `wd:${r.id}`).join(' ')} }
  ?item wdt:P31 ?type .
  ?type wdt:P279* ?root .
  FILTER NOT EXISTS { ?type wdt:P279* wd:${config.keepRoot.id} }
}`;
}

/** "Point(2.294479 48.858296)" -> { lat, lon }. Anything else is skipped. */
function parsePoint(wkt) {
  const match = /^Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(wkt ?? '');
  if (!match) return null;
  return { lon: Number(match[1]), lat: Number(match[2]) };
}

async function runQuery(query, config, contact) {
  const { endpoint, userAgentApp, maxRetries, retryDelayMs } = config.sparql;
  const url = `${endpoint}?query=${encodeURIComponent(query)}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/sparql-results+json',
          'User-Agent': `${userAgentApp} (${contact})`,
        },
      });
    } catch (error) {
      warn(`network error (attempt ${attempt}/${maxRetries}): ${error.message}`);
      await sleep(retryDelayMs);
      continue;
    }

    // 429 is the rate limiter, 502/504 is the query service shedding load, and
    // a timed-out query comes back 500 with a plain-text body. All three are
    // worth retrying; a 400 means the query itself is wrong and never will be.
    if (response.ok) {
      try {
        return (await response.json()).results.bindings;
      } catch {
        warn(`unparseable response (attempt ${attempt}/${maxRetries})`);
      }
    } else if (response.status === 400) {
      throw new Error(`Wikidata rejected the query: ${await response.text()}`);
    } else {
      warn(`HTTP ${response.status} (attempt ${attempt}/${maxRetries})`);
    }
    await sleep(retryDelayMs);
  }
  return null;
}

/**
 * The landmark index, built or loaded from cache.
 *
 * Exported so the pool builder can call this directly - the index is an input
 * to a pool build the same way the GeoNames dumps are, and a fresh checkout
 * should not need two commands to build a pool.
 */
export async function ensureLandmarkIndex({ force = false, contact = 'wanderguess' } = {}) {
  const config = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, 'config/landmark-config.json'), 'utf8')
  );
  const indexPath = path.join(PROJECT_ROOT, config.output.indexPath);

  if (!force) {
    try {
      const cached = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      if (cached?.landmarks?.length) {
        log(`using cached index of ${cached.landmarks.length} landmarks`);
        return cached.landmarks;
      }
    } catch {
      // No index yet - build one.
    }
  }

  log(`querying Wikidata for ${config.classes.length} landmark classes at >= ${config.minSitelinks} sitelinks`);

  // Keyed by Wikidata QID: an item is usually an instance of several classes
  // (Neuschwanstein is a castle and a palace), and the widest radius wins -
  // it is the same building either way, and the more prominent reading of what
  // it is should decide how far away it stays recognisable.
  const byId = new Map();
  const failed = [];

  for (const klass of config.classes) {
    await sleep(config.sparql.requestDelayMs);
    const rows = await runQuery(classQuery(klass.id, config.minSitelinks), config, contact);

    if (rows === null) {
      failed.push(klass);
      warn(`${klass.name} (${klass.id}) failed after ${config.sparql.maxRetries} attempts`);
      continue;
    }

    let added = 0;
    for (const row of rows) {
      const point = parsePoint(row.coord?.value);
      if (!point) continue;

      const id = row.item.value.split('/').pop();
      const name = row.itemLabel?.value ?? '';
      // An unlabelled item comes back as its own QID, which is no use as a
      // landmark name and is a sign the label service dropped the row.
      if (!name || /^Q\d+$/.test(name)) continue;

      const existing = byId.get(id);
      if (existing) {
        existing.radiusM = Math.max(existing.radiusM, klass.radiusM);
        continue;
      }
      byId.set(id, {
        id,
        name,
        lat: Number(point.lat.toFixed(6)),
        lon: Number(point.lon.toFixed(6)),
        sitelinks: Number(row.sitelinks.value),
        kind: klass.name,
        radiusM: klass.radiusM,
      });
      added++;
    }
    log(`  ${klass.name}: ${rows.length} rows, ${added} new (${byId.size} total)`);
  }

  if (byId.size === 0) {
    throw new Error(
      'Wikidata returned no landmarks at all. The query service may be down - ' +
        'try again, or lower minSitelinks in config/landmark-config.json.'
    );
  }

  // Drop the settlements and administrative units that came in through the
  // broader classes. A batch that fails is NOT treated as "nothing to exclude":
  // that would silently readmit whole cities, which is the exact failure this
  // step exists to prevent, so the whole build fails instead.
  const ids = [...byId.keys()];
  const excluded = new Set();
  for (let i = 0; i < ids.length; i += config.excludeBatchSize) {
    const batch = ids.slice(i, i + config.excludeBatchSize);
    await sleep(config.sparql.requestDelayMs);
    const rows = await runQuery(exclusionQuery(batch, config), config, contact);
    if (rows === null) {
      throw new Error(
        `The settlement-exclusion query failed for items ${i}-${i + batch.length}. ` +
          'Refusing to write an index that would list cities as landmarks - rerun with --force.'
      );
    }
    for (const row of rows) excluded.add(row.item.value.split('/').pop());
  }

  // Kept in the output, not just counted. A filter can only ever make its own
  // number look better, and the two earlier versions of this exclusion each
  // produced a cleaner-looking index by removing the landmarks the mode exists
  // for. The list of what went is the only thing that shows that.
  const dropped = [...excluded]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .sort((a, b) => b.sitelinks - a.sitelinks)
    .map((l) => ({ id: l.id, name: l.name, sitelinks: l.sitelinks, kind: l.kind }));

  // The one check the exclusion cannot perform on itself. Every wrong version
  // of this rule scored better on its own output - fewer items, no cities in
  // the top of the list - while removing the landmarks easy mode exists for.
  // Only an externally-supplied list of names can catch that.
  const casualties = config.mustSurvive.filter((l) => excluded.has(l.id));
  if (casualties.length > 0) {
    throw new Error(
      `The settlement exclusion removed ${casualties.length} landmark(s) that must survive: ` +
        `${casualties.map((l) => `${l.name} (${l.id})`).join(', ')}. ` +
        'Narrow excludeRoots or widen keepRoot in config/landmark-config.json - ' +
        'do not relax mustSurvive, which is the only check on this rule that its own output cannot fake.'
    );
  }

  for (const id of excluded) byId.delete(id);
  log(
    `dropped ${dropped.length} settlements and administrative units` +
      (dropped.length
        ? `, most famous first: ${dropped
            .slice(0, 8)
            .map((l) => l.name)
            .join(', ')}${dropped.length > 8 ? '…' : ''}`
        : '')
  );

  // Most famous first, so a truncated or sampled index is still the good half.
  const landmarks = [...byId.values()].sort((a, b) => b.sitelinks - a.sitelinks);

  await fs.writeFile(
    indexPath,
    JSON.stringify(
      {
        version: config.version,
        generatedAt: new Date().toISOString(),
        minSitelinks: config.minSitelinks,
        count: landmarks.length,
        // Recorded rather than dropped silently: a class that failed is a hole
        // in the index, and a later "why are there no easy locations in Asia"
        // needs to be able to see that temples never made it in.
        failedClasses: failed.map((c) => `${c.name} (${c.id})`),
        // Written so the exclusion can be reviewed for what it takes, not only
        // for how many. Read this before widening excludeRoots.
        excluded: dropped,
        landmarks,
      },
      null,
      2
    )
  );

  log(`wrote ${landmarks.length} landmarks to ${config.output.indexPath}`);
  if (failed.length > 0) {
    warn(
      `${failed.length} classes failed and are missing from the index: ` +
        failed.map((c) => c.name).join(', ') +
        ' - rerun with --force to retry them'
    );
  }
  return landmarks;
}

// Run directly, rather than imported by the pool builder.
if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--force');
  ensureLandmarkIndex({ force, contact: process.env.NOMINATIM_CONTACT || 'wanderguess' }).catch(
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}
