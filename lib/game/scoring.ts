import { FIRST_TIER, TIERS } from './constants';
import type { Scope, TierConfig } from '@/lib/types/game';
import type { LocationAnswer, TierId } from '@/lib/types/location';

/** Tier lookup by id. Throws rather than returning undefined - an unknown tier is a bug. */
export function getTier(id: TierId): TierConfig {
  const tier = TIERS.find((t) => t.id === id);
  if (!tier) throw new Error(`Unknown tier: ${id}`);
  return tier;
}

/** The tier after this one, or null when the turn is complete. */
export function getNextTier(id: TierId): TierId | null {
  const index = TIERS.findIndex((t) => t.id === id);
  if (index === -1) throw new Error(`Unknown tier: ${id}`);
  return index < TIERS.length - 1 ? TIERS[index + 1].id : null;
}

/** Index of a tier in the ladder. Throws on an unknown id. */
function tierIndex(id: TierId): number {
  const index = TIERS.findIndex((t) => t.id === id);
  if (index === -1) throw new Error(`Unknown tier: ${id}`);
  return index;
}

/**
 * The first tier a player actually guesses.
 *
 * A scoped match skips whatever the scope already gives away: picking a
 * continent means nobody guesses the continent, and picking a country removes
 * the country tier as well. Asking anyway would hand out free points every turn.
 */
export function getStartTier(scope: Scope): TierId {
  if (scope.type === 'continent') return 'country';
  if (scope.type === 'country') return 'region';
  return FIRST_TIER;
}

/** The tiers actually in play, from the starting tier to the last. */
export function getLiveTiers(startTier: TierId): TierConfig[] {
  return TIERS.slice(tierIndex(startTier));
}

/**
 * Total points banked once this tier is answered correctly.
 *
 * Cumulative rather than incremental - clearing the city tier is worth every
 * point below it, because the player had to climb through them to get there.
 * Cumulative *from the starting tier*, though: in a Europe match the country
 * tier is worth 2 rather than 3, because the continent point was never on offer.
 * That is why this sums the ladder instead of reading `cumulative` from config,
 * which only describes a whole-world match.
 */
export function getBankedScore(id: TierId, startTier: TierId = FIRST_TIER): number {
  const start = tierIndex(startTier);
  const end = tierIndex(id);
  if (end < start) {
    throw new Error(`Tier ${id} is not in play for a match starting at ${startTier}`);
  }
  return TIERS.slice(start, end + 1).reduce((sum, tier) => sum + tier.points, 0);
}

/** The most one turn can be worth in a match starting at this tier. */
export function getPerfectRoundScore(startTier: TierId = FIRST_TIER): number {
  return getBankedScore(TIERS[TIERS.length - 1].id, startTier);
}

/** Location names compare case- and whitespace-insensitively. */
function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().trim();
}

export function isCorrectGuess(
  guess: string,
  answer: LocationAnswer,
  tier: TierId
): boolean {
  return normalize(guess) === normalize(answer[tier]);
}

/**
 * Human-readable answer, most specific part first:
 * "Rue de Rivoli, Paris, Ile-de-France, France".
 *
 * The street leads because it is the most specific thing known and the tier the
 * player most likely just lost on. Absent from manifests built before the
 * street tier, so it is filtered out rather than left as a leading comma.
 */
export function formatAnswer(answer: LocationAnswer): string {
  return [answer.street, answer.city, answer.region, answer.country]
    .filter(Boolean)
    .join(', ');
}
