# Wanderguess roadmap

Ideas that are not built yet. Each entry records why it is wanted and what would
have to be decided before building it, so the reasoning survives the gap between
having the idea and acting on it.

## Difficulty modes: easy / medium / hard — **built 2026-08-13**

Shipped as designed. See the README for how the three passes work and CLAUDE.md
for the traps. What is worth keeping from the design discussion is what changed
on contact with the data:

- **Proximity is not visibility, and the cheap half of the fix was enough to
  ship.** Landmarks now carry a visibility radius per *kind* — 900 m for a
  tower, 150 m for a fountain — and the round opens facing the landmark, using
  the `compass_angle` the coverage tile already carries. The llava vision check
  was deliberately not built; an occluded landmark can still slip through, and
  that is the accepted cost.
- **Manual curation turned out to be unnecessary.** Wikidata plus a sitelink
  threshold produces the index automatically, and the binding constraint is
  Mapillary's coverage beside landmarks rather than the size of the list.
- **Hard is unfiltered rather than a third bucket.** "Anywhere, significant or
  not" includes the landmarks, and partitioning the modes would have made hard a
  smaller pool than the game had before difficulty existed.
- **Hard mode is now honestly "anywhere".** The rural pass samples the coverage
  graph — the `sequence` layer exists at every zoom, so a coarse tile is a
  sampler for where imagery is — instead of seeding on cities.

### Still open

- **Easy mode has hit a hard ceiling, and it is coverage, not the target.** The
  landmark pass stopped at **192 of a 210 target after exhausting all 1,093
  landmarks in the index** — Mapillary simply has no 360° imagery beside most
  famous places. Raising `easy.targetCount` cannot help; the only lever is a
  bigger index, and `minSitelinks` 40 → 30 roughly doubles it. Measured
  2026-08-14, not estimated.
- **The visible-landmark promise is unmeasured.** Nobody has counted how often
  the landmark is actually in frame. A sample of thirty easy rounds looked at by
  hand would say whether the radius table needs tightening, and is worth more
  than adding a vision model on a guess.
- **Landmark radii are judgement, not measurement.** They were reasoned about
  per class and never checked against a real panorama.

## Pool size

**430 → 723** on 2026-08-14 (913 cached) by raising the easy and rural targets
and running the city pass again. Four things learned while doing it, all of them
cost time:

- **Keep "throttled" and "no data here" as different states.** 36 locations
  finished the main sweep flagged *never looked up* rather than *no streets*,
  because Overpass had refused those batches; a rerun recovered 22. Collapsing
  the two would have made that loss permanent and invisible — the pool would
  simply have been smaller, with nothing to indicate why.

- **Estimate the street yield from a random sample, not the first N.** An early
  read of 94% came from the smoke-test entries, which were unrepresentative; the
  real figure over the whole pool was 69% before the radius escalation, 79% after.
- **The manifest is now emitted in a stable order.** It used to be shuffled at
  build time, which changed nothing about the game — `selectMatchLocations`
  shuffles at play time — and made every rebuild an 11,583-line diff in both
  directions for identical content.
- **Region quotas that cannot be met report it.** Seven of 23 regions fell short
  on the rural pass and the Caribbean stopped at 6/9 on the city pass; those are
  coverage facts, and the build says so rather than emitting a quietly shorter
  pool.

## A fifth tier: the street name — **built 2026-08-13**

Shipped as designed: +5 points, a perfect whole-world turn is 15, and a
country-scoped match is region → city → street for 12. See the README for the
pipeline and CLAUDE.md for the traps. Three things the design note got wrong,
all of them only visible once it was built:

- **The answer is not free.** The reverse-geocode the pool builder already makes
  runs at `zoom=12` and returns no `road` key at all. The street answer needs a
  *second* Nominatim call at zoom 18, so the tier doubles the geocoding cost
  rather than adding nothing. Raising the existing call's zoom instead would
  change which address keys come back and silently re-tune the city answers.
- **"Query named ways within a small radius" is the wrong access pattern.**
  `way(around:250,…)` took 22 seconds where the same area as a bbox took 0.35 —
  `around` computes distances, a bbox uses the spatial index. And one request per
  location got the IP blocked outright by the main Overpass instance before 5% of
  the sweep was done. Batching a dozen bboxes per query and assigning results
  back by each way's `center` turned 1,090 requests into about 45.
- **One widen step was not enough, and the shortfall looked like coverage.** A
  Moscow location has exactly one named way inside 250 m — its own — 11 inside
  700 m, and 55 inside 2 km. Stopping at 700 m recorded it as "not enough named
  neighbours" and dropped it, along with about a fifth of the pool. The fix is an
  escalating radius list where each step only re-asks about the locations still
  short.

**The tension resolved as the note predicted: require a street.** The number the
note asked for, measured on the 557-location pool rather than guessed, is in the
build log — a location with no named road, or too few named neighbours to ask
about it, is dropped rather than played on a shorter ladder. A turn capped at 10
while the next player's is worth 15 would be unfair in exactly the way the scope
rules are careful never to be.

### Still open

**The +5 is unplayed.** The note wanted a few rounds played before committing to
the value, and that has not happened. A street sign in frame makes the tier free;
no sign makes it close to a coin flip between five plausible names. That variance
is arguably the point, but a tier that is usually unguessable is just a tax on
the player who got that far — and 5 is the largest single prize on the ladder.

**Distractors can now come from 2 km away** in the quietest locations, where the
first version would have drawn them from 250 m. Still genuinely nearby streets,
but a player who knows the town may rule them out on distance rather than on
looking. Worth a glance if the tier starts feeling easy in familiar places.

## Visited-places pool ("places I have actually been")

**Proposed 2026-08-13 by the owner.**

Instead of seeding the pool from random cities worldwide, let a configuration
file name places the player has genuinely travelled to. Recognising a street you
have actually stood on is a different and better feeling than guessing a country
from which side of the road the cars drive on — and knowing every location is
somewhere you have been makes a wrong answer feel like a memory failure rather
than a coin flip.

Configuration only, deliberately not a frontend UI: the pool is a build-time
artifact, and a travel list is stable enough that editing a file beats building
a place-picker nobody would use twice.

### How it fits the existing pipeline

The builder already seeds on GeoNames cities inside a region bbox. This becomes
an alternative seed source rather than a new pipeline:

- add `seedMode: "regions" | "visited"` to `config/pool-config.json`
- add `config/visited-places.json` listing places as `{ country, region, city }`
  or explicit coordinates
- resolve each entry to a GeoNames city, then run the existing find → verify →
  bake-distractors stages unchanged

Everything downstream — the adaptive bbox, Nominatim verification, sibling
distractors, the manifest schema — works as-is.

### Open questions to settle first

**Distractors decide whether this stays a *looking* game.** If wrong answers are
drawn from the visited list, a player who knows the list can answer from memory
without examining the panorama, and it degrades into a recall quiz. Drawing them
from real geographic siblings (current behaviour) keeps the image load-bearing.
Recommendation: keep sibling distractors, and treat the easier feel as coming
from familiarity with the *place*, not from a shorter menu.

**Pool size interacts with match length.** A personal travel list might hold 30–80
places, against `minPoolSize` of 10 and one distinct location per player per
round. Eight players over 15 rounds needs 120. Either the setup screen's existing
round clamping absorbs this — it already does — or a visited pool blends with a
random one, which would need a per-location `familiar` flag if the reveal is to
say which is which.

**Coverage is not guaranteed.** The current smoke test found zero 360° imagery in
Mexico, Central America, the Caribbean and Eastern Europe. A visited list is a
fixed set of places rather than a quota to fill from a large candidate pool, so
some entries simply will not resolve. The builder should report which visited
places produced nothing, rather than silently emitting a shorter pool.

**This publishes a travel history.** `public/data/locations.json` is served as a
static asset, so a visited-places pool puts a list of where the owner has
personally been at a public URL, with coordinates and dates. That may be
completely fine — or it may argue for keeping this pool local, or deploying it
behind Cloudflare Access. Decide before the first deploy, not after.

## Region-level concurrency in the pool builder

A full 2,250-location build takes well over 12 hours, because only ~19% of
Mapillary imagery is 360° and each accepted location costs roughly ten API round
trips. Regions are independent, so 6–8 concurrent workers would cut this to a
couple of hours. Nominatim's 1 request/second policy is global, so it needs a
single shared rate limiter across workers rather than a per-worker delay.

## Thin regions

Re-measured 2026-08-14 against a 723-location pool (913 cached). The shortfalls
below are Mapillary coverage facts, not tuning mistakes — every one of them is a
region where the builder spent its full attempt budget and said so rather than
emitting a quietly shorter pool.

**City pass** — seven of 23 regions could not fill their quota:

| Region | Result | Attempts spent |
|---|---|---|
| West and North Africa | 5/11 | 250 |
| East Asia mainland | 6/11 | 200 |
| Caribbean | 6/9 | 125 |
| Japan and Korea | 16/24 | 300 |
| Middle East | 11/13 | 175 |
| East Africa | 8/9 | 175 |
| South Asia | 15/16 | 200 |

**Rural pass** — seven of 23 regions short, Canada the worst at 5/12 after 96
tiles. **Landmark pass** — 192 of a 210 target, having exhausted *all 1,093*
landmarks in the index.

Africa is still the gap but no longer a hole: **10 locations → 30**, entirely
because the rural pass exists. China's absence from East Asia is unchanged and
unsurprising.

The lever that remains is different per mode:

- **Easy** is capped by coverage beside famous places. `easy.targetCount` cannot
  help — the index was exhausted. Lower `minSitelinks` (40 → 30 roughly doubles
  it) or accept 174.
- **Medium and hard** can still absorb a larger `--limit` on the city pass and a
  higher `rural.targetCountPerRegion`; neither has hit a ceiling.
- What **not** to do is unchanged: relaxing `filters.cameraTypes` to admit
  perspective images would fill every quota instantly and turn a look-around
  game into a flat photo quiz. Prefer smaller honest quotas.

### A correction worth keeping

An earlier smoke test (one location per region, so only 25 attempts each)
returned nothing for seven regions, and this file recorded that as evidence that
"Mapillary's 360° coverage concentrates in Western Europe, North America, Japan,
Brazil, the Southern Cone and Australia."

**That was wrong** — an artifact of the attempt budget, not a property of the
corpus. At full scale each region gets 25 × its target, and four of those seven
filled completely:

| Region | Smoke test | Full build |
|---|---|---|
| Eastern Europe | 0/1 | **7/7** |
| Mexico and Central America | 0/1 | **6/6** |
| Caribbean | 0/1 | **3/3** |
| South Asia | 0/1 | **6/6** |

The lesson is about method rather than geography: a region returning nothing
under a small budget means *not enough attempts*, not *no coverage*. Do not
conclude a region is empty without giving it a real budget first.

Quotas can still be tuned from measured hit rates — Japan needed up to 86
attempts per accept against Tokyo density, while Mexico landed one in 3 — but
that is an efficiency question now, not a coverage one.

The tempting wrong fix, whenever a region does look thin, is to relax
`filters.cameraTypes` to admit perspective images. That would fill every quota
instantly and turn a look-around game into a flat photo quiz. Prefer smaller
honest quotas.

## Mapillary logo asset

The attribution bar currently uses a text wordmark. Mapillary's API terms ask for
their logo linked to their homepage. Vendoring `mapillary-logo.svg` into `public/`
and rendering it in `AttributionBar` would fully satisfy this.
