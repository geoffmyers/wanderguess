import type { Difficulty, GameLocation, TierId } from './location';

export type GamePhase = 'setup' | 'playing' | 'reveal' | 'victory' | 'pool_missing';

export type ScopeType = 'world' | 'continent' | 'country';

/**
 * Restricts a match to one part of the world. Narrowing the scope also removes
 * the tiers it gives away: choosing a continent means nobody guesses the
 * continent, and choosing a country removes the country tier too.
 */
export interface Scope {
  type: ScopeType;
  /** Continent or country name; null when the scope is the whole world. */
  value: string | null;
}

export interface ScopeOption {
  value: string;
  count: number;
}

export interface DifficultyConfig {
  id: Difficulty;
  label: string;
  blurb: string;
  /**
   * Which locations the mode draws from: `landmark` and `metro` match the
   * location's own difficulty, `any` matches everything.
   */
  poolRule: 'landmark' | 'metro' | 'any';
}

/**
 * Which of the two match filters is responsible for a pool too small to play.
 *
 * Scope and difficulty are independent, and either can empty a pool on its own
 * - Easy plus South America may well hold nothing. Naming the wrong one, or
 * neither, makes an ordinary combinatorial gap read as a bug.
 */
export type PoolShortfall = 'scope' | 'difficulty' | 'both' | 'pool' | null;

export interface Player {
  id: number;
  name: string;
  score: number;
}

export interface TierConfig {
  id: TierId;
  label: string;
  question: string;
  /** Points this tier adds on its own. */
  points: number;
  /** Total banked once this tier is answered correctly. */
  cumulative: number;
  optionSource: 'fixed' | 'baked';
}

/** Why the current turn ended, used to word the reveal screen. */
export type TurnOutcome = 'wrong' | 'perfect';

export interface TurnResult {
  playerId: number;
  location: GameLocation;
  outcome: TurnOutcome;
  /** Tier the player failed on, or null for a perfect turn. */
  failedTier: TierId | null;
  pointsEarned: number;
}
