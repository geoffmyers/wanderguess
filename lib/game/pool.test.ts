import { describe, expect, it } from 'vitest';

import { CONTINENTS } from './constants';
import {
  buildTierOptions,
  diagnosePoolShortfall,
  difficultyOf,
  filterPool,
  filterPoolByDifficulty,
  filterPoolByScope,
  getAvailableDifficulties,
  getAvailableScopes,
  isPlayableLocation,
  loadPoolFromManifest,
  selectMatchLocations,
  shuffle,
} from './pool';

import type { Scope } from '@/lib/types/game';
import type { Difficulty, GameLocation, LocationManifest } from '@/lib/types/location';

function makeLocation(overrides: Partial<GameLocation> = {}): GameLocation {
  return {
    id: 'img-1',
    lat: 48.8584,
    lon: 2.2945,
    capturedAt: '2023-06-12',
    creator: 'someone',
    answer: {
      continent: 'Europe',
      country: 'France',
      region: 'Île-de-France',
      city: 'Paris',
      street: 'Rue de Rivoli',
    },
    options: {
      country: ['Spain', 'Italy', 'Portugal', 'Belgium'],
      region: ['Normandy', 'Brittany', 'Occitanie', 'Grand Est'],
      city: ['Versailles', 'Créteil', 'Nanterre', 'Meaux'],
      street: ['Rue Saint-Honoré', 'Quai du Louvre', 'Rue du Bac', 'Rue de Rennes'],
    },
    ...overrides,
  };
}

describe('isPlayableLocation', () => {
  it('accepts a complete entry', () => {
    expect(isPlayableLocation(makeLocation())).toBe(true);
  });

  it('rejects an entry missing an answer', () => {
    const location = makeLocation();
    location.answer.city = '';
    expect(isPlayableLocation(location)).toBe(false);
  });

  it('rejects a tier with no distractors, which would be a free point', () => {
    const location = makeLocation();
    location.options.region = [];
    expect(isPlayableLocation(location)).toBe(false);
  });

  it('rejects a tier whose only distractor is the answer itself', () => {
    const location = makeLocation();
    location.options.city = ['Paris'];
    expect(isPlayableLocation(location)).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    expect(isPlayableLocation({} as GameLocation)).toBe(false);
  });
});

describe('loadPoolFromManifest', () => {
  it('reports how many entries were rejected so a degraded pool is visible', () => {
    const broken = makeLocation({ id: 'img-2' });
    broken.options.city = [];

    const manifest = {
      version: '1.0.0',
      generatedAt: '2026-08-13T00:00:00Z',
      count: 2,
      locations: [makeLocation(), broken],
    } as LocationManifest;

    const result = loadPoolFromManifest(manifest);
    expect(result.locations).toHaveLength(1);
    expect(result.dropped).toBe(1);
  });

  it('survives a manifest with no locations array', () => {
    const result = loadPoolFromManifest({} as LocationManifest);
    expect(result.locations).toEqual([]);
    expect(result.dropped).toBe(0);
  });
});

describe('selectMatchLocations', () => {
  const pool = Array.from({ length: 20 }, (_, i) => makeLocation({ id: `img-${i}` }));

  it('returns exactly the number of turns requested', () => {
    expect(selectMatchLocations(pool, 8)).toHaveLength(8);
  });

  it('never repeats a location within a match', () => {
    const ids = selectMatchLocations(pool, 20).map((l) => l.id);
    expect(new Set(ids).size).toBe(20);
  });

  it('throws rather than silently reusing when the pool is too small', () => {
    expect(() => selectMatchLocations(pool, 21)).toThrow(/needs 21/);
  });
});

describe('buildTierOptions', () => {
  const location = makeLocation();

  it('offers every continent, in a stable order players can learn', () => {
    expect(buildTierOptions(location, 'continent')).toEqual(CONTINENTS);
  });

  it('always includes the correct answer', () => {
    for (const tier of ['country', 'region', 'city'] as const) {
      expect(buildTierOptions(location, tier)).toContain(location.answer[tier]);
    }
  });

  it('offers the answer plus its distractors', () => {
    expect(buildTierOptions(location, 'country')).toHaveLength(5);
  });

  it('does not list the answer twice when a distractor duplicates it', () => {
    const duplicated = makeLocation();
    duplicated.options.country = ['France', 'Spain', 'Italy'];
    const options = buildTierOptions(duplicated, 'country');
    expect(options.filter((o) => o === 'France')).toHaveLength(1);
  });
});

describe('shuffle', () => {
  it('preserves every element', () => {
    const input = [1, 2, 3, 4, 5];
    expect(shuffle(input).sort()).toEqual(input);
  });

  it('does not mutate its input', () => {
    const input = [1, 2, 3];
    shuffle(input);
    expect(input).toEqual([1, 2, 3]);
  });
});

describe('scope filtering', () => {
  const mixed: GameLocation[] = [
    makeLocation({ id: 'fr-1' }),
    makeLocation({ id: 'fr-2' }),
    makeLocation({
      id: 'de-1',
      answer: {
        continent: 'Europe',
        country: 'Germany',
        region: 'Bavaria',
        city: 'Munich',
        street: 'Marienplatz',
      },
    }),
    makeLocation({
      id: 'us-1',
      answer: {
        continent: 'North America',
        country: 'United States',
        region: 'Ohio',
        city: 'Akron',
        street: 'Main Street',
      },
    }),
  ];

  it('returns the whole pool for a world scope', () => {
    expect(filterPoolByScope(mixed, { type: 'world', value: null })).toHaveLength(4);
  });

  it('keeps only the chosen continent', () => {
    const europe = filterPoolByScope(mixed, { type: 'continent', value: 'Europe' });
    expect(europe.map((l) => l.id)).toEqual(['fr-1', 'fr-2', 'de-1']);
  });

  it('keeps only the chosen country', () => {
    const france = filterPoolByScope(mixed, { type: 'country', value: 'France' });
    expect(france.map((l) => l.id)).toEqual(['fr-1', 'fr-2']);
  });

  it('returns nothing for a place the pool does not contain', () => {
    expect(filterPoolByScope(mixed, { type: 'country', value: 'Peru' })).toEqual([]);
  });

  it('does not mutate the pool it filters', () => {
    filterPoolByScope(mixed, { type: 'country', value: 'France' });
    expect(mixed).toHaveLength(4);
  });

  it('lists available scopes with counts, most populous first', () => {
    const { continents, countries } = getAvailableScopes(mixed);
    expect(continents).toEqual([
      { value: 'Europe', count: 3 },
      { value: 'North America', count: 1 },
    ]);
    expect(countries[0]).toEqual({ value: 'France', count: 2 });
    expect(countries.map((c) => c.value)).toContain('United States');
  });

  it('reports no scopes for an empty pool rather than throwing', () => {
    expect(getAvailableScopes([])).toEqual({ continents: [], countries: [] });
  });
});

describe('difficulty', () => {
  const WORLD: Scope = { type: 'world', value: null };

  function poolOf(spec: [Difficulty | undefined, string][]): GameLocation[] {
    return spec.map(([difficulty, continent], i) =>
      makeLocation({
        id: `img-${i}`,
        difficulty,
        answer: {
          continent,
          country: `Country${i}`,
          region: `Region${i}`,
          city: `City${i}`,
          street: `Street${i}`,
        },
      })
    );
  }

  it('treats a location with no difficulty as hard', () => {
    expect(difficultyOf(makeLocation())).toBe('hard');
    expect(difficultyOf(makeLocation({ difficulty: 'easy' }))).toBe('easy');
  });

  it('normalises an unrecognised difficulty to hard rather than losing the location', () => {
    const manifest = {
      version: '1',
      generatedAt: '',
      count: 1,
      locations: [makeLocation({ difficulty: 'impossible' as Difficulty })],
    } as LocationManifest;

    const { locations, dropped } = loadPoolFromManifest(manifest);
    expect(dropped).toBe(0);
    // The point: it stays playable in some mode instead of matching none of them.
    expect(filterPoolByDifficulty(locations, 'hard')).toHaveLength(1);
  });

  it('filters easy and medium to their own locations', () => {
    const pool = poolOf([
      ['easy', 'Europe'],
      ['easy', 'Asia'],
      ['medium', 'Europe'],
      ['hard', 'Europe'],
    ]);
    expect(filterPoolByDifficulty(pool, 'easy')).toHaveLength(2);
    expect(filterPoolByDifficulty(pool, 'medium')).toHaveLength(1);
  });

  it('lets hard admit everything, landmarks included', () => {
    // "Anywhere, significant or not" is the mode's definition, and treating the
    // three modes as a partition would make hard a SMALLER pool than the game
    // had before difficulty existed.
    const pool = poolOf([
      ['easy', 'Europe'],
      ['medium', 'Europe'],
      ['hard', 'Europe'],
    ]);
    expect(filterPoolByDifficulty(pool, 'hard')).toHaveLength(3);
  });

  it('applies scope and difficulty together', () => {
    const pool = poolOf([
      ['easy', 'Europe'],
      ['easy', 'Asia'],
      ['medium', 'Europe'],
    ]);
    const europe: Scope = { type: 'continent', value: 'Europe' };
    expect(filterPool(pool, europe, 'easy')).toHaveLength(1);
    expect(filterPool(pool, europe, 'hard')).toHaveLength(2);
  });

  it('counts each difficulty within the current scope, not across the pool', () => {
    const pool = poolOf([
      ['easy', 'Europe'],
      ['easy', 'Asia'],
      ['easy', 'Asia'],
      ['medium', 'Europe'],
    ]);
    const counts = new Map(
      getAvailableDifficulties(pool, { type: 'continent', value: 'Europe' }).map((d) => [
        d.id,
        d.count,
      ])
    );
    expect(counts.get('easy')).toBe(1);
    expect(counts.get('medium')).toBe(1);
    expect(counts.get('hard')).toBe(2);
  });

  describe('diagnosePoolShortfall', () => {
    it('reports nothing when the pool is big enough', () => {
      const pool = poolOf([
        ['easy', 'Europe'],
        ['easy', 'Europe'],
      ]);
      expect(diagnosePoolShortfall(pool, WORLD, 'easy', 2)).toBeNull();
    });

    it('blames difficulty when dropping it alone would be enough', () => {
      const pool = poolOf([
        ['easy', 'Europe'],
        ['hard', 'Europe'],
        ['hard', 'Europe'],
      ]);
      expect(diagnosePoolShortfall(pool, WORLD, 'easy', 3)).toBe('difficulty');
    });

    it('blames scope when dropping it alone would be enough', () => {
      const pool = poolOf([
        ['easy', 'Europe'],
        ['easy', 'Asia'],
        ['easy', 'Asia'],
      ]);
      const europe: Scope = { type: 'continent', value: 'Europe' };
      expect(diagnosePoolShortfall(pool, europe, 'easy', 3)).toBe('scope');
    });

    it('blames the combination when each setting is fine on its own', () => {
      // Three easy locations and three in Europe, but only one that is both -
      // exactly the Easy-plus-South-America case, and the one that would read
      // as a bug if the message named a single filter.
      const pool = poolOf([
        ['easy', 'Europe'],
        ['easy', 'Asia'],
        ['easy', 'Asia'],
        ['hard', 'Europe'],
        ['hard', 'Europe'],
      ]);
      const europe: Scope = { type: 'continent', value: 'Europe' };
      expect(diagnosePoolShortfall(pool, europe, 'easy', 3)).toBe('both');
    });

    it('blames the pool itself when nothing would help', () => {
      const pool = poolOf([['easy', 'Europe']]);
      expect(diagnosePoolShortfall(pool, WORLD, 'hard', 5)).toBe('pool');
    });
  });
});

describe('diagnosePoolShortfall when neither setting is enough alone', () => {
  it('still says both, without claiming either works on its own', () => {
    // Four in Europe, four easy, only one that is both, and needing five: this
    // is the branch where NEITHER filter alone would leave enough, which reads
    // differently from the case where each is individually fine.
    const pool: GameLocation[] = [
      ...Array.from({ length: 3 }, (_, i) =>
        makeLocation({
          id: `eu-hard-${i}`,
          difficulty: 'hard',
          answer: {
            continent: 'Europe',
            country: 'A',
            region: 'B',
            city: `C${i}`,
            street: `S${i}`,
          },
        })
      ),
      makeLocation({
        id: 'eu-easy',
        difficulty: 'easy',
        answer: {
          continent: 'Europe',
          country: 'A',
          region: 'B',
          city: 'C9',
          street: 'S9',
        },
      }),
      ...Array.from({ length: 3 }, (_, i) =>
        makeLocation({
          id: `as-easy-${i}`,
          difficulty: 'easy',
          answer: {
            continent: 'Asia',
            country: 'D',
            region: 'E',
            city: `F${i}`,
            street: `T${i}`,
          },
        })
      ),
    ];

    const europe: Scope = { type: 'continent', value: 'Europe' };
    expect(filterPoolByScope(pool, europe).length).toBe(4);
    expect(filterPoolByDifficulty(pool, 'easy').length).toBe(4);
    expect(diagnosePoolShortfall(pool, europe, 'easy', 5)).toBe('both');
  });
});
