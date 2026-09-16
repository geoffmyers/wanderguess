import { CONTINENTS, DIFFICULTIES, TIERS } from './constants';
import type { PoolShortfall, Scope, ScopeOption } from '@/lib/types/game';
import type {
  BakedTierId,
  Difficulty,
  GameLocation,
  LocationManifest,
  TierId,
} from '@/lib/types/location';

/** Fisher-Yates. Returns a new array; the input is untouched. */
export function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Derived from config rather than listed, so adding a tier does not need an
 * edit here. Adding the street tier and forgetting this list would have let
 * locations with no street distractors into the pool, where the round would
 * offer a single option that is also the answer.
 */
const BAKED_TIERS = TIERS.filter((t) => t.optionSource === 'baked').map(
  (t) => t.id as BakedTierId
);

/**
 * A location is only playable if every tier has an answer and every baked tier
 * has at least one distractor. A tier whose only option is the correct answer
 * would hand the player free points, so such entries are dropped rather than
 * shown - a malformed manifest should cost coverage, not silently make the game
 * easier.
 *
 * That applies to the street tier exactly as it does to the others, and it is
 * the reason a location with no named road is dropped instead of played with a
 * shorter ladder: every other rule in this game exists to make turns worth the
 * same, and a turn capped at 10 while the next is worth 15 would break that for
 * the player unlucky enough to be dealt it.
 */
export function isPlayableLocation(location: GameLocation): boolean {
  if (!location?.id || !location.answer || !location.options) return false;

  const answers = TIERS.map((tier) => location.answer[tier.id]);
  if (!answers.every((v) => typeof v === 'string' && v.trim())) return false;

  return BAKED_TIERS.every((tier) => {
    const distractors = location.options[tier];
    if (!Array.isArray(distractors) || distractors.length === 0) return false;
    // A distractor equal to the answer is a build bug, not a valid option.
    return distractors.some(
      (d) => d.trim().toLowerCase() !== (location.answer[tier] ?? '').trim().toLowerCase()
    );
  });
}

export interface PoolLoadResult {
  locations: GameLocation[];
  dropped: number;
}

/**
 * Filters a manifest down to playable locations, reporting how many were
 * rejected so a degraded pool is visible rather than silently smaller.
 *
 * Difficulty is normalised here rather than trusted: an unrecognised value
 * would match no mode at all, so the location would vanish from easy and medium
 * *and* still be counted in the manifest total - a location that exists but can
 * never be dealt. Falling back to `hard` keeps it playable.
 */
export function loadPoolFromManifest(manifest: LocationManifest): PoolLoadResult {
  const all = Array.isArray(manifest?.locations) ? manifest.locations : [];
  const known = new Set(DIFFICULTIES.map((d) => d.id));
  const locations = all.filter(isPlayableLocation).map((location) =>
    known.has(location.difficulty as Difficulty)
      ? location
      : { ...location, difficulty: 'hard' as Difficulty }
  );
  return { locations, dropped: all.length - locations.length };
}

/**
 * Picks the distinct locations a whole match needs, one per turn. Throws when
 * the pool is too small - callers clamp the round count up front via
 * maxRoundsForPool, so reaching here short is a bug worth surfacing.
 */
export function selectMatchLocations(
  pool: readonly GameLocation[],
  turnsNeeded: number
): GameLocation[] {
  if (turnsNeeded > pool.length) {
    throw new Error(
      `Pool has ${pool.length} locations but the match needs ${turnsNeeded}`
    );
  }
  return shuffle(pool).slice(0, turnsNeeded);
}

/** The locations a scope admits. A world scope admits everything. */
export function filterPoolByScope(
  pool: readonly GameLocation[],
  scope: Scope
): GameLocation[] {
  if (scope.type === 'world' || !scope.value) return [...pool];
  const key = scope.type === 'continent' ? 'continent' : 'country';
  return pool.filter((location) => location.answer[key] === scope.value);
}

/**
 * A location's own difficulty, defaulting to `hard`.
 *
 * Manifests built before difficulty modes carry no field at all, and every one
 * of those locations was found by seeding on a city with no landmark test - so
 * `hard` is what they honestly are, not a placeholder.
 */
export function difficultyOf(location: GameLocation): Difficulty {
  return location.difficulty ?? 'hard';
}

/**
 * The locations a difficulty admits.
 *
 * Hard admits everything. That is the mode's definition - "anywhere, urban or
 * rural, significant or not" - and it is also what keeps hard mode from being a
 * *smaller* pool than the game had before difficulty existed, which is what
 * treating the three modes as a partition would have done.
 */
export function filterPoolByDifficulty(
  pool: readonly GameLocation[],
  difficulty: Difficulty
): GameLocation[] {
  const rule = DIFFICULTIES.find((d) => d.id === difficulty)?.poolRule ?? 'any';
  if (rule === 'any') return [...pool];
  return pool.filter((location) => difficultyOf(location) === difficulty);
}

/** The locations a match actually draws from, once both filters are applied. */
export function filterPool(
  pool: readonly GameLocation[],
  scope: Scope,
  difficulty: Difficulty
): GameLocation[] {
  return filterPoolByDifficulty(filterPoolByScope(pool, scope), difficulty);
}

/**
 * Which filter is responsible for a pool too small to play, or null when it is
 * big enough.
 *
 * Scope and difficulty are independent, so a combination can come up empty when
 * neither setting is unreasonable on its own - Easy plus South America is the
 * obvious case. Blaming the wrong filter, or neither, turns an ordinary
 * combinatorial gap into something that reads like a bug.
 */
export function diagnosePoolShortfall(
  pool: readonly GameLocation[],
  scope: Scope,
  difficulty: Difficulty,
  needed: number
): PoolShortfall {
  if (filterPool(pool, scope, difficulty).length >= needed) return null;
  if (pool.length < needed) return 'pool';

  const scopeOnly = filterPoolByScope(pool, scope).length >= needed;
  const difficultyOnly = filterPoolByDifficulty(pool, difficulty).length >= needed;

  // Dropping difficulty alone would fix it, so difficulty is what emptied it.
  if (scopeOnly && !difficultyOnly) return 'difficulty';
  if (difficultyOnly && !scopeOnly) return 'scope';

  // Either both settings are individually fine and only their intersection is
  // thin, or neither is fine on its own. Both cases answer to the same advice -
  // relax one of the two - so they share a verdict, and the wording must not
  // claim each works alone, because in the second case neither does.
  return 'both';
}

/**
 * How many locations each difficulty offers under the current scope.
 *
 * Counted within the scope rather than across the whole pool, because a count
 * the current scope cannot deliver is worse than no count at all - it would
 * offer Easy as though it had 90 locations while a Japan match had none.
 */
export function getAvailableDifficulties(
  pool: readonly GameLocation[],
  scope: Scope
): { id: Difficulty; count: number }[] {
  const scoped = filterPoolByScope(pool, scope);
  return DIFFICULTIES.map((d) => ({
    id: d.id,
    count: filterPoolByDifficulty(scoped, d.id).length,
  }));
}

function countBy(pool: readonly GameLocation[], key: 'continent' | 'country'): ScopeOption[] {
  const counts = new Map<string, number>();
  for (const location of pool) {
    const value = location.answer[key];
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Every continent and country the pool actually contains, with counts, most
 * populous first. Counts are returned rather than filtered here so the setup
 * screen can show *why* a scope is unavailable instead of silently hiding it.
 */
export function getAvailableScopes(pool: readonly GameLocation[]): {
  continents: ScopeOption[];
  countries: ScopeOption[];
} {
  return {
    continents: countBy(pool, 'continent'),
    countries: countBy(pool, 'country'),
  };
}

/**
 * The buttons shown for one tier. Continents are fixed and always all seven, in
 * config order, so players learn a stable layout. Every other tier is the
 * correct answer shuffled into its baked distractors.
 */
export function buildTierOptions(location: GameLocation, tier: TierId): string[] {
  if (tier === 'continent') return [...CONTINENTS];

  const answer = location.answer[tier] ?? '';
  const distractors = location.options[tier as BakedTierId].filter(
    (d) => d.trim().toLowerCase() !== answer.trim().toLowerCase()
  );

  return shuffle([answer, ...distractors]);
}
