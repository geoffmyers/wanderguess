import gameConfig from '@/config/game-config.json';
import type { DifficultyConfig, TierConfig } from '@/lib/types/game';
import type { Difficulty, TierId } from '@/lib/types/location';

/**
 * Every rule the game enforces comes from config/game-config.json. Nothing in
 * this file may introduce a value of its own - it only types and re-exports.
 */

export const TIERS = gameConfig.tiers as TierConfig[];

export const TIER_IDS = TIERS.map((t) => t.id);

export const FIRST_TIER: TierId = TIERS[0].id;

export const CONTINENTS: string[] = gameConfig.continents;

export const DIFFICULTIES = gameConfig.difficulties as DifficultyConfig[];

export const DIFFICULTY_IDS = DIFFICULTIES.map((d) => d.id);

/** Hard by default: it plays the whole pool, so a fresh visit can never land on an empty one. */
export const DEFAULT_DIFFICULTY = gameConfig.defaultDifficulty as Difficulty;

export const GAME = gameConfig.game;

export const TURN_RULES = gameConfig.turnRules;

export const VICTORY = gameConfig.victoryCondition;

export const ATTRIBUTION = gameConfig.attribution;

export const VIEWER = gameConfig.viewer;

/** Highest score a single turn can produce - the last tier's cumulative total. */
export const PERFECT_ROUND_SCORE: number = GAME.perfectRoundScore;

export const MANIFEST_URL = '/data/locations.json';
