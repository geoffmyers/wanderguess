import { describe, expect, it } from 'vitest';

import {
  determineWinners,
  isMatchOver,
  maxRoundsForPool,
  playerIndexForTurn,
  rankPlayers,
  roundForTurn,
  totalTurns,
} from './turns';

import type { Player } from '@/lib/types/game';

const roster = (...scores: number[]): Player[] =>
  scores.map((score, i) => ({ id: i + 1, name: `P${i + 1}`, score }));

describe('turn rotation', () => {
  it('cycles players in order', () => {
    const seen = [0, 1, 2, 3, 4, 5].map((t) => playerIndexForTurn(t, 3));
    expect(seen).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('handles solo play, where every turn is the same player', () => {
    expect([0, 1, 2].map((t) => playerIndexForTurn(t, 1))).toEqual([0, 0, 0]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'gives every player equal turns with %i players',
    (playerCount) => {
      const rounds = 4;
      const counts = new Array(playerCount).fill(0);
      for (let turn = 0; turn < totalTurns(playerCount, rounds); turn++) {
        counts[playerIndexForTurn(turn, playerCount)]++;
      }
      expect(counts.every((c) => c === rounds)).toBe(true);
    }
  );

  it('rejects an empty roster instead of dividing by zero', () => {
    expect(() => playerIndexForTurn(0, 0)).toThrow(/at least 1/);
  });
});

describe('round derivation', () => {
  it('advances only after every player has taken a turn', () => {
    expect([0, 1, 2, 3].map((t) => roundForTurn(t, 2))).toEqual([1, 1, 2, 2]);
  });

  it('counts rounds one-based for display', () => {
    expect(roundForTurn(0, 4)).toBe(1);
  });
});

describe('isMatchOver', () => {
  it('is false until the final turn has been played', () => {
    // 2 players x 3 rounds = 6 turns, indices 0..5
    expect(isMatchOver(5, 2, 3)).toBe(false);
    expect(isMatchOver(6, 2, 3)).toBe(true);
  });

  it('never ends mid-round, so turn order confers no advantage', () => {
    for (let rounds = 1; rounds <= 5; rounds++) {
      for (let players = 1; players <= 8; players++) {
        const end = totalTurns(players, rounds);
        expect(end % players).toBe(0);
      }
    }
  });
});

describe('determineWinners', () => {
  it('returns the single highest scorer', () => {
    expect(determineWinners(roster(4, 9, 2)).map((p) => p.id)).toEqual([2]);
  });

  it('returns every player tied at the top', () => {
    expect(determineWinners(roster(7, 7, 3)).map((p) => p.id)).toEqual([1, 2]);
  });

  it('treats an all-zero game as a full tie rather than no winner', () => {
    expect(determineWinners(roster(0, 0)).length).toBe(2);
  });

  it('returns nothing for an empty roster', () => {
    expect(determineWinners([])).toEqual([]);
  });
});

describe('rankPlayers', () => {
  it('sorts by score descending without mutating the input', () => {
    const players = roster(3, 10, 6);
    expect(rankPlayers(players).map((p) => p.score)).toEqual([10, 6, 3]);
    expect(players.map((p) => p.score)).toEqual([3, 10, 6]);
  });
});

describe('maxRoundsForPool', () => {
  it('divides the pool between the players', () => {
    expect(maxRoundsForPool(100, 4)).toBe(25);
  });

  it('rounds down so no location is ever reused', () => {
    expect(maxRoundsForPool(10, 3)).toBe(3);
  });

  it('is zero when the pool cannot cover a single round', () => {
    expect(maxRoundsForPool(2, 5)).toBe(0);
  });

  it('is zero rather than infinite for an empty roster', () => {
    expect(maxRoundsForPool(50, 0)).toBe(0);
  });
});
