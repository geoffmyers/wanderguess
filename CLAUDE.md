# CLAUDE.md - Wanderguess

Technical guidance for AI assistants working on this codebase. Start with
[README.md](README.md) for what the game is and how to run it; this file covers
the things that will bite you.

## Stack

Next.js 16 (App Router, `output: 'export'`), React 19, TypeScript, Zustand 5
with `persist`, plain CSS custom properties, Vitest. Deployed as static assets
on a Cloudflare Worker. No Tailwind, no framer-motion, no three.js — the
Next.js sibling (music-ear-trainer) uses plain CSS and this follows it.

## Non-negotiables

**Game rules live in `config/game-config.json`.** Scoring, tier order, round
options, player limits, phase names, difficulty modes. `lib/game/constants.ts`
only types and re-exports them — it must never introduce a value of its own.
Same for `config/pool-config.json` and `config/landmark-config.json`: the pool
builder and the landmark indexer read every knob from there.

**Free APIs only.** Mapillary and GeoNames were chosen because they need no
billing account. Google's Street View Static API requires a credit card on file
even inside its free tier and forbids caching imagery. Do not reintroduce it.

**Attribution is licence compliance, not decoration.** `AttributionBar` must
stay visible on the game board. Mapillary imagery is CC BY-SA 4.0 (credit the
contributor, link the licence) and Mapillary's API terms separately require a
visible link back to their homepage.

## Traps

| Trap | What happens |
|---|---|
| `camera_type` has **two** 360 values | Mapillary documents `perspective\|fisheye\|equirectangular`, but live responses also return `spherical` — and it is the *more common* of the two (215 vs 58 in a 10-city sample). Filtering on `equirectangular` alone silently discards ~79% of usable panoramas. `filters.cameraTypes` lists both. |
| `camera_type=` as a query param is **silently ignored** | It returns mixed camera types while looking like a working filter, so a pool built trusting it would be full of flat photos with no error to warn you. `is_pano=true` is the parameter that actually filters. |
| 360 imagery is only ~19% of Mapillary | Most images are perspective or fisheye. This is why discovery filters *before* fetching rather than after — see below. |
| The documented bbox cap is not the real limit (bbox mode only) | "Under 0.01 square degrees" is not what bites. A server-side **data volume** limit returns HTTP 500 (`"reduce the amount of data"`) far earlier in dense areas: central Berlin fails even at 0.0003°, while a quiet town is fine at 0.08°. In `discoveryMode: "bbox"` the box adapts — halving on 500, doubling on an empty result. Do not replace it with a fixed size. Tile mode sidesteps this entirely. |
| Thumbnail URLs are signed and may expire | This is why the manifest stores only image IDs and resolves URLs at play time. Do not bake `thumb_*_url` into the manifest. |
| Panorama textures must be power-of-two | `EquirectViewer` redraws every image to 2048×1024 before upload. NPOT textures cannot use `REPEAT` on WebGL1, and the 360° seam becomes visible. Do not "optimise" that redraw away. |
| Cross-origin images taint the upload canvas | Images load with `crossOrigin = 'anonymous'`. Without it `texImage2D` throws and the viewer silently drops to the flat fallback. |
| A broad Wikidata root **always** times out | `wdt:P31/wdt:P279* wd:Q811979` (architectural structure) is millions of items and never returns inside the 60 s query-service budget; `wd:Q12518` (tower) returns in about a second. This is why `landmark-config.json` lists ~26 narrow classes and queries them one at a time. Probe a candidate with `scripts/probe-wikidata-classes.mjs` before adding it. |
| Landmark classes leak **whole cities** | "Archaeological site" contributes Pompeii and the Valley of the Kings, and also Athens, Cairo, Damascus, Cologne and Alexandria — each a city with a coordinate at its centre, which would make every downtown panorama an easy round whose landmark is the city being guessed. A `human settlement` exclusion pass removes them. Do not widen that exclusion: `administrative territorial entity` and `human-geographic territorial entity` both take the Eiffel Tower, Big Ben and the Statue of Liberty with them, and the index looks *better* afterwards — smaller and free of cities — while missing every landmark the mode exists for. |
| The equirect centre is the camera heading, not north | Verified rather than assumed, because a wrong assumption here opens every easy round pointing somewhere arbitrary while still rendering a perfectly ordinary street — nothing would flag it. For image `2104698996700350` the heading is 243.2°, the geographic bearing to the next image in its sequence is 245.4°, and the rendered centre view is the road ahead. `node scripts/verify-viewer.mjs <id> --bearings -90,0,90` re-checks the viewer half: a positive bearing must show what lies to the **right** of the source image's centre. |
| **`compass_angle` is often a stand-in `0.0`** — use `computed_compass_angle` | This is the trap that actually shipped and had to be caught by looking at a picture. The coverage tile carries only the raw `compass_angle`, which is the device heading and is frequently `0.0` where the camera recorded none — indistinguishable from a camera genuinely pointing north. The Arc de Triomphe panorama is one: raw `0.0` against a computed `134.9`, so the baked bearing aimed the round **121° away from an arch standing dead ahead**, and rendered an unremarkable Paris street while doing it. Two of six sampled easy locations had a raw `0.0`, and others disagreed with the computed value by up to 86°. `computed_compass_angle` is Mapillary's structure-from-motion correction and is the only one to trust; it comes from the Graph call each accepted location already makes for the creator name. A location with no computed heading gets **no** `initialYaw` — opening straight ahead is a smaller failure than opening confidently in the wrong direction. |
| The street call must **not** send `Accept-Language: en` | The verification call asks for English so its answers match GeoNames. The street call must not, because Overpass answers with the OSM `name` tag and Nominatim with `en` answers with `name:en` — two namespaces, and the tier breaks both ways. A Kyiv round offered `Kyyevo-Myrotska Street` as the answer and `Києво-Мироцька вулиця` among the distractors — the same street, so picking the right one scored zero. A Luxor round put an English answer among four Arabic distractors, the visual odd one out, pickable without looking at the panorama. The local name is also just correct: this is the tier you solve by finding a street sign, and the sign says the local name. |
| Nominatim's `road` needs **zoom 18** | The verification call runs at `zoom: 12` and returns no `road` key at all, so the street answer is a *second* request rather than a free field on the existing one. Do not "optimise" that by raising the existing call's zoom: it changes which address keys come back and silently re-tunes the city answers that `settlementKeys` and `adminSuffixPattern` were built around. |
| Overpass `around` is ~60× slower than a bbox, and per-location querying gets you **blocked** | `way(around:250,…)` took 22 s where the equivalent `way(south,west,north,east)` took 0.35 s — `around` computes distances, a bbox uses the spatial index. Worse, one request per location (1,090 for this pool) had the main instance refusing this IP entirely before 5% of the sweep finished, and it stays blocked for a while. The street pass therefore batches a dozen bboxes into one query and assigns results back by each way's `center`. A throttled Overpass answers **200 with an HTML error page**, so `response.json()` throws — treat that as a retry, never as "this location has no streets", or throttling becomes permanent pool shrinkage. |
| Nominatim allows 1 request/second | `rateLimitMs` is 1100 with a descriptive User-Agent. A full pool build takes well over half an hour; that is expected, and the cache makes it resumable. |
| `public/data/locations.json` is publicly readable | Inherent to a static export. Answers are visible in devtools. Accepted deliberately — do not add obfuscation. |

## Pool discovery: tiles, not bbox

`discoveryMode: "tiles"` (default) reads Mapillary's pre-rendered coverage
tiles. `"bbox"` is the older `/images?bbox=` path, kept as a fallback.

The gap is an order of magnitude, measured rather than assumed: one z14 tile
over central Amsterdam returns 63,837 images carrying **15,723 panoramas** in a
single request, against 263 for the best bbox query before the server refused.
Tiles are fixed-size and pre-rendered, so density cannot fail them — and a tile
with no coverage reports zero, which is a fact rather than an error to retry
around.

Things worth knowing before changing it:

- **The tile has no creator username**, which CC-BY-SA attribution requires. One
  Graph call follows each *accepted* location, placed after every other filter
  so a rejected candidate costs nothing.
- **Tiles are cached** (`tileCacheSize`) because adjacent seed cities often
  share one and a dense tile is several megabytes. Refetching per seed would
  undo the win.
- **`quality_score` and `sequence_id`** come free with the tile and were
  unavailable on the bbox path. `minQualityScore` is wired up and currently 0.
- **Log lines are mode-aware.** Printing the adaptive box size in tile mode
  would describe machinery that never ran — that already happened once, and a
  log that misdescribes its own behaviour is how the original silent failure
  went unnoticed for ten minutes.

## The street tier

Five tiers now, ending on the street: 1 / 2 / 3 / 4 / 5, a perfect whole-world
turn is **15**, and a scoped one is 14 or 12.

**A location with no street is dropped, not played short.** `isPlayableLocation`
requires every tier's answer and every baked tier's distractors, street
included. Playing a shorter ladder instead would make one turn worth 10 while
the next is worth 15 — unfair in exactly the way the scope rules are careful
never to be, since scope changes the ladder for *everybody in the match*. The
cost is about 6% of the pool, measured rather than guessed, which is what the
ROADMAP asked for before this was built.

**`BAKED_TIERS` derives from config**, not from a literal list. It used to be
`['country', 'region', 'city']`, and adding a tier without noticing would have
admitted locations whose street round offers one option that is also the answer.

**Long options widen the grid from their content, not from the tier id** —
`option-grid.wide` triggers on any option over 18 characters, so it also catches
a long city or region rather than hardcoding "street".

## Auto-pan

`autoPanStep()` is a **pure function, exported and unit-tested**, and that is
deliberate. A screenshot test of it was written, run, and deleted: Chromium's
headless virtual-time mode advances timers without producing matching animation
frames, so the sweep rendered as barely moved whether the maths was right or
wrong. A test that cannot fail is worse than none. The three failure modes that
matter — a flipped direction, a per-frame instead of per-second step, and a
missing backgrounded-tab clamp — are each caught by a different test; that was
confirmed by mutating the source, not assumed.

The direction depends on the same sign relationship as `initialBearingDeg`
(positive turns right, which the shader reaches by *decreasing* yaw), and that
one **was** verified against rendered pixels.

**It starts on its own, so `yieldToUser()` is load-bearing.** Every interaction
path has to stop the sweep — `pointerdown` for click, touch and drag, and
`wheel` for zoom. The wheel was missed on the first pass and only mattered once
the default flipped to on: before that, a sweep the player had started
themselves continuing through a zoom was merely odd, not something they had
clearly asked to stop.

The initial value also reads `prefers-reduced-motion` (lazily, because
`matchMedia` does not exist during prerender and the static export's first
render must match). Config can override that with `respectsReducedMotion`.

`autoPan` state lives in `PanoramaViewer`, not in the viewer instance, because
the viewer is rebuilt for every location and the setting should survive the
round. It must stay out of the loading effect's dependency array — listing it
there tears down the viewer and refetches the panorama on every button press.
The viewer calls `onAutoPanChange` when a drag stops the sweep, or the button
would go on claiming it is panning.

## Turn model

The photo game's `(currentPlayerIndex + 1) % 2` plus its `pendingWinner` /
`isTieBreaker` pair does **not** generalise. Here everything derives from a
single monotonic `turnIndex`:

```
playerIndex = turnIndex % playerCount
round       = floor(turnIndex / playerCount) + 1
matchOver   = turnIndex >= playerCount * totalRounds
```

Because a match is always a whole number of rounds, every player has equal
turns by construction and no tie-breaker logic is needed at all. If you find
yourself adding a special case for who goes last, the model has been broken.

## Scoped matches

`scope` restricts a match to one continent or country, and **skips the tiers the
scope gives away** — Europe starts at country, a country scope starts at region.

The consequence that trips people: **`cumulative` in `game-config.json` is only
true for a whole-world match.** In a Europe match the country tier banks 2, not
3, because the continent point was never on offer. `getBankedScore(tier,
startTier)` sums the ladder from the starting tier rather than reading
`cumulative`, and `getPerfectRoundScore` gives 10 / 9 / 7. Anything computing a
maximum score must pass the start tier — `VictoryScreen`'s solo total did, and
would silently overstate the target otherwise.

`filterPool` (scope **and** difficulty) is applied everywhere pool size is
measured, not just when dealing: round-count clamping in `setPool`, `setScope`
and `setDifficulty`, the setup screen's `canStart`, and `availableRounds`. Miss
one and the game offers a match length the settings cannot fill. `clampRounds`
exists so those three call sites cannot drift apart.

## Difficulty modes

Orthogonal to scope, and scoring is untouched — see `difficulties` in
`config/game-config.json`.

**Hard is unfiltered, not "the leftovers".** Its `poolRule` is `any`, so it
deals landmarks too. The mode means "anywhere, significant or not", and
partitioning the three modes would make hard a *smaller* pool than the game had
before difficulty existed. If you find yourself writing
`difficultyOf(l) === 'hard'` in a filter, that is the bug.

**Difficulty is classified at emit time from the location's coordinates**, not
recorded by whichever pass found it. A city-pass panorama under the Colosseum is
an easy location. `--emit-only` reclassifies an existing cache with no network.

**A location with no `difficulty` is `hard`**, and so is one carrying an
unrecognised value — `loadPoolFromManifest` normalises it. An unknown string
would otherwise match no mode at all: still counted in the manifest, never
dealt in any of the three.

**Easy mode cannot be a filter over the city-seeded pool.** Panoramas beside
world-famous landmarks are a vanishing fraction of Mapillary, so the landmark
pass seeds on landmark coordinates and searches outward. That is the opposite
direction from every other pass.

**Both pickers show counts conditioned on the other setting.** `ScopePicker`
counts within the chosen difficulty and `DifficultyPicker` within the chosen
scope, because "Japan (14)" is a lie in easy mode if only two carry a landmark.
Thin *scopes* are hidden; thin *difficulties* are dimmed but stay selectable, so
`diagnosePoolShortfall` can say which of the two filters emptied the pool — a
greyed-out chip never says that, and the ROADMAP asked for the message
specifically.

`minimumMatchLocations()` is the single "is this playable?" threshold. It is the
shortest *match*, not one round; the scope picker used to test one round and so
offered scopes that then had no round chip to select, which reads as Start being
broken.

## Store notes

- `pool` is **not** persisted (refetched each visit); `matchLocations` **is**,
  so a refresh mid-match resumes without the pool.
- `setPool` must not disturb a match already in progress — it only reacts in
  `setup` / `pool_missing`. A mid-match round-count clamp would truncate the game.
- Round clamping snaps to an offered option in `roundOptions`, not to the raw
  maximum, or the setup screen shows no selected chip while Start is enabled.
- Page render is gated on a `mounted` flag so the static export's HTML matches
  the client's first render regardless of localStorage contents.

## Common tasks

**Change scoring.** Edit `tiers` in `config/game-config.json`. Keep `cumulative`
equal to the running sum of `points` and `game.perfectRoundScore` equal to the
last tier's cumulative — `scoring.test.ts` enforces both.

**Add a tier.** Add it to `config/game-config.json`, add it to `TierId` in
`lib/types/location.ts` (`BakedTierId` follows automatically), give it an answer
field and a distractor list in the pool builder's emit, and update the test
fixtures — `tsc` will point at every one of them. `getNextTier`, `getLiveTiers`,
`TierProgress`, `BAKED_TIERS` and the setup screen's scoring table are all
data-driven and need no changes. Keep `cumulative` equal to the running sum and
`game.perfectRoundScore` equal to the last tier's cumulative; `scoring.test.ts`
enforces both.

**The manifest is emitted sorted by image id, deliberately.** It used to be
shuffled at build time, which changed nothing — `selectMatchLocations` shuffles
at play time — while making every rebuild an 11,583-line diff in both directions
for byte-identical content. Keep it stable so a rebuild's diff shows the
locations that actually came and went.

**Rebuild or extend the pool.** Edit `regions` in `config/pool-config.json`,
then `npm run build-pool`. Use `--limit 50` for a quick smoke test, `--force` to
ignore the cache, and `--pass cities|landmarks|rural` to run one pass.

**Grow easy mode.** Lower `minSitelinks` in `config/landmark-config.json` (40 →
30 roughly doubles the index), or add a class after probing it with
`scripts/probe-wikidata-classes.mjs`, then
`node scripts/build-landmark-index.mjs --force` and
`npm run build-pool -- --pass landmarks`. Easy mode is limited by Mapillary
coverage beside landmarks far more than by the size of the index.

**Test the UI without a token.** Write a fixture manifest to
`public/data/locations.json` with made-up answers and distractors. Everything
except the panorama itself works; the viewer shows its error state.

## Testing

`npm test` covers the pure logic — scoring tiers, turn rotation for 1–8
players, round derivation, match end, winners and ties, pool validation and
option building, and the full store flow.

**The headless Chrome available here has no WebGL at all** (`getContext('webgl')`
returns null for every variant). That matters: the viewer catches the failure
and drops to its flat-image fallback, so a broken shader and a missing GL
context look identical — the page renders, nothing throws, and the panorama is
just flat. Never conclude the viewer works from a browser check in this
environment.

To actually exercise the shader path:

```bash
node scripts/verify-viewer.mjs           # or pass a Mapillary image ID
```

It bundles the real `lib/viewer/equirect.ts` with esbuild, renders a live
panorama in the official Playwright Docker image under SwiftShader, and writes
`.viewer-verify/panorama.png`. **Look at the PNG.** A street scene means the
projection works; a uniform black frame means the shader ran and sampled
nothing, which a "did it throw?" check would call success.

Chromium must run in the Playwright image, never on the host — `/usr` is
read-only, `apt` is blocked, and the cached Playwright binary dies with
`libatk-1.0.so.0: cannot open shared object file`. See
[[feedback_playwright_via_distrobox_tools]].

The Mapillary network client is still unit-untested; it is thin, and the
verify script exercises it end to end.
