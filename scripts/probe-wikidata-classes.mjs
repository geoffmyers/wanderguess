#!/usr/bin/env node
/**
 * Probes how a Wikidata class behaves as a landmark seed before adding it to
 * config/landmark-config.json.
 *
 * The landmark index queries one class at a time on purpose. A single broad
 * root - `wdt:P31/wdt:P279* wd:Q811979` (architectural structure) - is millions
 * of items and times out the public query service every time, while the same
 * query against a narrower class returns in a few seconds. So the class list is
 * a tuning decision, and this is how you tune it: run a candidate class, look at
 * how many items come back, how long it took, and whether the sample is
 * actually landmarks rather than towns.
 *
 * Usage:
 *   node scripts/probe-wikidata-classes.mjs Q12518 Q12280 Q23413
 *   node scripts/probe-wikidata-classes.mjs --min 100 Q41176
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
let minSitelinks = 60;
const classes = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--min') {
    minSitelinks = Number(args[++i]);
    continue;
  }
  classes.push(args[i]);
}

if (classes.length === 0) {
  const config = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, 'config/landmark-config.json'), 'utf8')
  );
  classes.push(...config.classes.map((c) => c.id));
  minSitelinks = config.minSitelinks;
  console.log(`probing the ${classes.length} configured classes at >= ${minSitelinks} sitelinks\n`);
}

console.log(['class', 'items', 'seconds', 'sample'].join('\t'));

for (const qid of classes) {
  const query = `
SELECT ?item ?itemLabel ?coord ?sitelinks WHERE {
  ?item wdt:P31/wdt:P279* wd:${qid} ;
        wdt:P625 ?coord ;
        wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${minSitelinks})
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

  const started = Date.now();
  let rows = null;
  let note = '';
  try {
    const response = await fetch(
      'https://query.wikidata.org/sparql?query=' + encodeURIComponent(query),
      {
        headers: {
          Accept: 'application/sparql-results+json',
          'User-Agent': 'wanderguess-landmark-index/1.0 (geoff@geoffmyers.com)',
        },
      }
    );
    if (!response.ok) note = `HTTP ${response.status}`;
    else rows = (await response.json()).results.bindings;
  } catch (error) {
    note = error.message;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (!rows) {
    console.log([qid, note || 'timeout', seconds, ''].join('\t'));
    continue;
  }
  const sample = rows
    .slice(0, 4)
    .map((r) => `${r.itemLabel.value} (${r.sitelinks.value})`)
    .join(' · ');
  console.log([qid, rows.length, seconds, sample].join('\t'));
}
