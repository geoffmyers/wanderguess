import { describe, expect, it } from 'vitest';

import { GAME, TIERS } from './constants';
import {
  formatAnswer,
  getBankedScore,
  getLiveTiers,
  getNextTier,
  getPerfectRoundScore,
  getStartTier,
  getTier,
  isCorrectGuess,
} from './scoring';

import type { LocationAnswer } from '@/lib/types/location';

const answer: LocationAnswer = {
  continent: 'Europe',
  country: 'France',
  region: 'Île-de-France',
  city: 'Paris',
  street: 'Rue de Rivoli',
};

describe('tier configuration', () => {
  it('runs continent to street in scoring order', () => {
    expect(TIERS.map((t) => t.id)).toEqual([
      'continent',
      'country',
      'region',
      'city',
      'street',
    ]);
  });

  it('awards 1, 2, 3, 4 and 5 points per tier', () => {
    expect(TIERS.map((t) => t.points)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps each cumulative total equal to the running sum of points', () => {
    let running = 0;
    for (const tier of TIERS) {
      running += tier.points;
      expect(tier.cumulative).toBe(running);
    }
  });

  it('agrees with the configured perfect round score', () => {
    expect(TIERS[TIERS.length - 1].cumulative).toBe(GAME.perfectRoundScore);
  });
});

describe('getNextTier', () => {
  it('walks forward through the ladder', () => {
    expect(getNextTier('continent')).toBe('country');
    expect(getNextTier('country')).toBe('region');
    expect(getNextTier('region')).toBe('city');
  });

  it('returns null after the final tier, which ends the turn', () => {
    expect(getNextTier('city')).toBe('street');
    expect(getNextTier('street')).toBeNull();
  });
});

describe('getBankedScore', () => {
  it('banks the cumulative total, not the tier value alone', () => {
    expect(getBankedScore('continent')).toBe(1);
    expect(getBankedScore('country')).toBe(3);
    expect(getBankedScore('region')).toBe(6);
    expect(getBankedScore('city')).toBe(10);
    expect(getBankedScore('street')).toBe(15);
  });
});

describe('getTier', () => {
  it('throws on an unknown tier rather than returning undefined', () => {
    // @ts-expect-error deliberately invalid
    expect(() => getTier('planet')).toThrow(/Unknown tier/);
  });
});

describe('isCorrectGuess', () => {
  it('matches the answer for its own tier', () => {
    expect(isCorrectGuess('Paris', answer, 'city')).toBe(true);
    expect(isCorrectGuess('France', answer, 'country')).toBe(true);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(isCorrectGuess('  paris ', answer, 'city')).toBe(true);
  });

  it('does not match a different tier’s answer', () => {
    expect(isCorrectGuess('France', answer, 'city')).toBe(false);
  });

  it('rejects a near miss', () => {
    expect(isCorrectGuess('Paras', answer, 'city')).toBe(false);
  });
});

describe('formatAnswer', () => {
  it('reads most specific first', () => {
    expect(formatAnswer(answer)).toBe('Rue de Rivoli, Paris, Île-de-France, France');
  });

  it('skips empty parts rather than leaving stray commas', () => {
    expect(formatAnswer({ ...answer, region: '' })).toBe('Rue de Rivoli, Paris, France');
  });

  it('omits the street for a manifest built before the street tier', () => {
    const { street: _street, ...older } = answer;
    expect(formatAnswer(older)).toBe('Paris, Île-de-France, France');
  });
});

describe('scoped matches', () => {
  const world = { type: 'world', value: null } as const;
  const europe = { type: 'continent', value: 'Europe' } as const;
  const usa = { type: 'country', value: 'United States' } as const;

  it('starts at the first tier the scope does not give away', () => {
    expect(getStartTier(world)).toBe('continent');
    expect(getStartTier(europe)).toBe('country');
    expect(getStartTier(usa)).toBe('region');
  });

  it('only puts the remaining tiers in play', () => {
    expect(getLiveTiers('continent').map((t) => t.id)).toEqual([
      'continent',
      'country',
      'region',
      'city',
      'street',
    ]);
    expect(getLiveTiers('country').map((t) => t.id)).toEqual([
      'country',
      'region',
      'city',
      'street',
    ]);
    expect(getLiveTiers('region').map((t) => t.id)).toEqual(['region', 'city', 'street']);
  });

  it('banks cumulatively from the starting tier, not from the top', () => {
    // Europe: the continent point was never on offer, so country is worth 2.
    expect(getBankedScore('country', 'country')).toBe(2);
    expect(getBankedScore('region', 'country')).toBe(5);
    expect(getBankedScore('city', 'country')).toBe(9);

    // United States: continent and country both given.
    expect(getBankedScore('region', 'region')).toBe(3);
    expect(getBankedScore('city', 'region')).toBe(7);
  });

  it('leaves whole-world scoring exactly as it was', () => {
    expect(getBankedScore('continent')).toBe(1);
    expect(getBankedScore('country')).toBe(3);
    expect(getBankedScore('region')).toBe(6);
    expect(getBankedScore('city')).toBe(10);
    expect(getBankedScore('street')).toBe(15);
  });

  it('caps a perfect turn at 15, 14 and 12', () => {
    expect(getPerfectRoundScore('continent')).toBe(15);
    expect(getPerfectRoundScore('country')).toBe(14);
    expect(getPerfectRoundScore('region')).toBe(12);
  });

  it('never awards more than the whole-world maximum', () => {
    for (const start of ['continent', 'country', 'region', 'city', 'street'] as const) {
      expect(getPerfectRoundScore(start)).toBeLessThanOrEqual(GAME.perfectRoundScore);
    }
  });

  it('throws if asked for a tier the scope already gave away', () => {
    expect(() => getBankedScore('continent', 'country')).toThrow(/not in play/);
  });
});
