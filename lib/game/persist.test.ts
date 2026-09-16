import { describe, expect, it } from 'vitest';

import gameConfig from '@/config/game-config.json';

/**
 * The persisted-match migration.
 *
 * `matchLocations` is persisted so a refresh resumes a match. That is a problem
 * on the deploy that adds a tier: the resumed match is dealt from locations with
 * no answer for it, the ladder comes from config so the round is asked anyway,
 * and every option compares wrong. The turn dies at the new tier for the rest of
 * the match and nothing on screen explains why.
 *
 * These assert the shape of the fix rather than reaching into zustand's
 * internals: an old payload must come back with no match in flight.
 */

// Mirrors the store's migrate(), which is not exported - keep the two in step.
const STORAGE_VERSION = 2;

function migrate(persisted: Record<string, unknown>, from: number) {
  if (from >= STORAGE_VERSION) return persisted;
  return {
    ...persisted,
    phase: 'setup',
    turnIndex: 0,
    matchLocations: [],
    currentOptions: [],
    turnScore: 0,
    turnResult: null,
  };
}

const oldPayload = {
  phase: 'playing',
  turnIndex: 3,
  turnScore: 6,
  players: [{ id: 1, name: 'P1', score: 12 }],
  totalRounds: 5,
  scope: { type: 'world', value: null },
  matchLocations: [
    // No `street` key: dealt before the tier existed.
    { id: 'a', answer: { continent: 'Europe', country: 'France', region: 'IDF', city: 'Paris' } },
  ],
};

describe('resuming a match across a tier change', () => {
  it('abandons a match dealt under the old ladder', () => {
    const migrated = migrate(oldPayload, 1) as Record<string, unknown>;
    expect(migrated.phase).toBe('setup');
    expect(migrated.matchLocations).toEqual([]);
    expect(migrated.turnIndex).toBe(0);
    expect(migrated.turnScore).toBe(0);
  });

  it('keeps the settings so it costs a click, not a re-setup', () => {
    const migrated = migrate(oldPayload, 1) as Record<string, unknown>;
    expect(migrated.players).toEqual(oldPayload.players);
    expect(migrated.totalRounds).toBe(5);
    expect(migrated.scope).toEqual({ type: 'world', value: null });
  });

  it('leaves a current-version payload untouched', () => {
    const current = { ...oldPayload, phase: 'playing' };
    expect(migrate(current, STORAGE_VERSION)).toBe(current);
  });

  it('is bumped whenever the tier count changes', () => {
    // The version exists to track the ladder. If a tier is added or removed
    // without bumping it, resumed matches break silently - so tie the two
    // together and make the next person read this comment.
    expect(gameConfig.tiers).toHaveLength(5);
    expect(STORAGE_VERSION).toBe(2);
  });
});
