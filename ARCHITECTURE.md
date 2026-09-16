# Architecture

Wanderguess is a **static export** — there is no server. A build step produces a
location pool as JSON; the browser plays the game entirely client-side.

## Two halves

**Build time (Node scripts, `scripts/`)** assembles `public/data/locations.json`:

1. `build-landmark-index.mjs` queries Wikidata for landmarks, one narrow class at
   a time, and excludes human settlements.
2. `build-location-pool.mjs` runs four passes — cities, landmarks, rural, streets
   — reading Mapillary **coverage tiles** and keeping only 360° panoramas.
3. Each accepted location is reverse-geocoded (Nominatim), given distractors, and
   emitted with an answer for every tier.

**Play time (`app/`, `lib/`)** loads that manifest and never calls an API again,
apart from `lib/mapillary/client.ts` resolving panorama image URLs.

## Layout

| Path | What lives there |
|---|---|
| `config/` | **All tunable values.** `game-config.json` holds scoring, tiers, round options and difficulties; `pool-config.json` and `landmark-config.json` drive the builders. |
| `lib/game/` | Pure game logic — `scoring.ts`, `turns.ts`, `pool.ts`, `constants.ts`, and `store.ts` (the Zustand store with `persist`). No React. Each has a sibling `*.test.ts`. |
| `lib/viewer/` | `equirect.ts`, the WebGL equirectangular projection used by the panorama viewer. |
| `lib/mapillary/` | `client.ts` — the only network client at play time, used to resolve panorama image URLs. |
| `lib/types/` | Shared types, including `TierId` and the location shape. |
| `app/` | Next.js App Router pages and components. |
| `scripts/` | The build-time pool and landmark pipeline, plus `verify-viewer.mjs`. |

## Rules worth knowing before changing it

- **The store does not persist the pool.** `matchLocations` is persisted so a
  refresh mid-match resumes; `pool` is refetched each visit.
- **Config is not code.** `lib/game/constants.ts` only types and re-exports
  `config/game-config.json`; it must never introduce a value of its own.
- **The turn model is one counter.** `playerIndex`, `round` and `matchOver` all
  derive from a single monotonic `turnIndex`, so every player gets equal turns by
  construction and no tie-breaker logic exists. Adding a special case for who
  goes last means the model has been broken.
- **Scope changes the ladder.** A Europe match starts at country, so banked
  scores are not the `cumulative` values in config. Anything computing a maximum
  must pass the starting tier.
- **Difficulty is orthogonal to scope**, and *hard is unfiltered* — it means
  "anywhere, significant or not", so it includes landmarks too.
- **Attribution is licence compliance.** The attribution bar is not decoration;
  see the README's credits section.

`CLAUDE.md` documents the traps in the imagery pipeline in detail — several of
them are failures that shipped and had to be caught by looking at a rendered
picture rather than by a passing test.
