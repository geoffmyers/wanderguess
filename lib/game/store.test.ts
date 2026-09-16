import { beforeEach, describe, expect, it } from 'vitest';

import { GAME } from './constants';
import useGameStore from './store';

import type { Scope } from '@/lib/types/game';
import type { GameLocation } from '@/lib/types/location';

function makeLocation(index: number): GameLocation {
  return {
    id: `img-${index}`,
    lat: 10 + index,
    lon: 20 + index,
    capturedAt: '2023-01-01',
    creator: `creator-${index}`,
    answer: {
      continent: 'Europe',
      country: `Country${index}`,
      region: `Region${index}`,
      city: `City${index}`,
      street: `Street${index}`,
    },
    options: {
      country: ['A', 'B', 'C', 'D'],
      region: ['E', 'F', 'G', 'H'],
      city: ['I', 'J', 'K', 'L'],
      street: ['M', 'N', 'O', 'P'],
    },
  };
}

const pool = Array.from({ length: 40 }, (_, i) => makeLocation(i));

/** Answers the current tier correctly for whichever location is in play. */
function answerCorrectly() {
  const { currentTier, matchLocations, turnIndex, submitGuess } = useGameStore.getState();
  submitGuess(matchLocations[turnIndex].answer[currentTier] as string);
}

function setup(playerCount: number, rounds: number) {
  useGameStore.setState({
    phase: 'setup',
    players: Array.from({ length: playerCount }, (_, i) => ({
      id: i + 1,
      name: `P${i + 1}`,
      score: 0,
    })),
    totalRounds: rounds,
    turnIndex: 0,
    matchLocations: [],
    turnScore: 0,
    turnResult: null,
  });
  useGameStore.getState().setPool(pool, 0);
  useGameStore.setState({ totalRounds: rounds });
  return useGameStore.getState().startMatch();
}

beforeEach(() => {
  useGameStore.setState({
    phase: 'setup',
    // Reset explicitly: without this the suite only passes because the scoped
    // tests happen to run last, and reordering the file would break world mode.
    scope: { type: 'world', value: null },
    difficulty: 'hard',
    pool: [],
    poolLoaded: false,
    poolDropped: 0,
    matchLocations: [],
    turnIndex: 0,
    turnScore: 0,
    turnResult: null,
    feedbackMessage: '',
    lastGuess: null,
    lastGuessCorrect: null,
  });
});

describe('startMatch', () => {
  it('deals one distinct location per turn', () => {
    expect(setup(3, 4)).toBe(true);
    const { matchLocations } = useGameStore.getState();
    expect(matchLocations).toHaveLength(12);
    expect(new Set(matchLocations.map((l) => l.id)).size).toBe(12);
  });

  it('opens on the continent tier with a full set of options', () => {
    setup(2, 2);
    const { currentTier, currentOptions } = useGameStore.getState();
    expect(currentTier).toBe('continent');
    expect(currentOptions.length).toBeGreaterThan(1);
  });

  it('zeroes scores carried over from a previous match', () => {
    setup(2, 2);
    useGameStore.setState({
      players: useGameStore.getState().players.map((p) => ({ ...p, score: 17 })),
    });
    useGameStore.getState().startMatch();
    expect(useGameStore.getState().players.every((p) => p.score === 0)).toBe(true);
  });

  it('refuses to start when the pool cannot cover every turn', () => {
    useGameStore.setState({
      players: [
        { id: 1, name: 'P1', score: 0 },
        { id: 2, name: 'P2', score: 0 },
      ],
      totalRounds: 30,
    });
    useGameStore.setState({ pool: pool.slice(0, 5) });
    expect(useGameStore.getState().startMatch()).toBe(false);
  });
});

describe('a turn', () => {
  it('banks cumulative points as the player climbs the ladder', () => {
    setup(2, 2);

    answerCorrectly(); // continent
    expect(useGameStore.getState().currentTier).toBe('country');
    expect(useGameStore.getState().turnScore).toBe(1);

    answerCorrectly(); // country
    expect(useGameStore.getState().currentTier).toBe('region');
    expect(useGameStore.getState().turnScore).toBe(3);

    answerCorrectly(); // region
    expect(useGameStore.getState().currentTier).toBe('city');
    expect(useGameStore.getState().turnScore).toBe(6);
  });

  it('awards the full 15 for clearing every tier', () => {
    setup(2, 2);
    for (let i = 0; i < 5; i++) answerCorrectly();

    const state = useGameStore.getState();
    expect(state.phase).toBe('reveal');
    expect(state.players[0].score).toBe(15);
    expect(state.turnResult?.outcome).toBe('perfect');
    expect(state.turnResult?.failedTier).toBeNull();
  });

  it('ends the turn on a wrong answer but keeps what was banked', () => {
    setup(2, 2);
    answerCorrectly(); // continent, banks 1
    answerCorrectly(); // country, banks 3
    useGameStore.getState().submitGuess('definitely not the region');

    const state = useGameStore.getState();
    expect(state.phase).toBe('reveal');
    expect(state.players[0].score).toBe(3);
    expect(state.turnResult?.outcome).toBe('wrong');
    expect(state.turnResult?.failedTier).toBe('region');
  });

  it('scores nothing when the very first guess is wrong', () => {
    setup(2, 2);
    useGameStore.getState().submitGuess('Atlantis');

    expect(useGameStore.getState().players[0].score).toBe(0);
    expect(useGameStore.getState().turnResult?.pointsEarned).toBe(0);
  });

  it('credits the player whose turn it is, not always the first', () => {
    setup(2, 2);
    useGameStore.getState().submitGuess('wrong');
    useGameStore.getState().nextTurn();

    for (let i = 0; i < 5; i++) answerCorrectly();

    const { players } = useGameStore.getState();
    expect(players[0].score).toBe(0);
    expect(players[1].score).toBe(15);
  });

  it('ignores a guess submitted while the reveal is showing', () => {
    setup(2, 2);
    useGameStore.getState().submitGuess('wrong');
    const before = useGameStore.getState().players[0].score;
    useGameStore.getState().submitGuess('wrong again');
    expect(useGameStore.getState().players[0].score).toBe(before);
  });
});

describe('match progression', () => {
  it('resets to the continent tier for the next player', () => {
    setup(2, 2);
    answerCorrectly();
    useGameStore.getState().submitGuess('wrong');
    useGameStore.getState().nextTurn();

    const state = useGameStore.getState();
    expect(state.currentTier).toBe('continent');
    expect(state.turnScore).toBe(0);
    expect(state.phase).toBe('playing');
  });

  it('reaches victory only after every player has had every round', () => {
    const players = 3;
    const rounds = 2;
    setup(players, rounds);

    for (let turn = 0; turn < players * rounds; turn++) {
      expect(useGameStore.getState().phase).toBe('playing');
      useGameStore.getState().submitGuess('wrong');
      useGameStore.getState().nextTurn();
    }

    expect(useGameStore.getState().phase).toBe('victory');
  });

  it('plays solo as a straight run of rounds', () => {
    setup(1, 3);
    for (let turn = 0; turn < 3; turn++) {
      for (let i = 0; i < 5; i++) answerCorrectly();
      useGameStore.getState().nextTurn();
    }

    const state = useGameStore.getState();
    expect(state.phase).toBe('victory');
    expect(state.players[0].score).toBe(45);
  });
});

describe('setPool', () => {
  it('flags an unusable pool before a match starts', () => {
    useGameStore.getState().setPool(pool.slice(0, 2), 0);
    expect(useGameStore.getState().phase).toBe('pool_missing');
  });

  it('recovers from pool_missing once a usable pool arrives', () => {
    useGameStore.getState().setPool([], 0);
    expect(useGameStore.getState().phase).toBe('pool_missing');
    useGameStore.getState().setPool(pool, 0);
    expect(useGameStore.getState().phase).toBe('setup');
  });

  it('snaps a persisted round count down to an offered option the pool supports', () => {
    useGameStore.setState({
      phase: 'setup',
      totalRounds: 15,
      players: [
        { id: 1, name: 'P1', score: 0 },
        { id: 2, name: 'P2', score: 0 },
      ],
    });
    // 12 locations / 2 players supports 6 rounds, but 6 is not an offered
    // option, so it must land on 5 rather than an unselectable 6.
    useGameStore.getState().setPool(pool.slice(0, 12), 0);
    expect(useGameStore.getState().totalRounds).toBe(5);
    expect(GAME.roundOptions).toContain(useGameStore.getState().totalRounds);
  });

  it('leaves an already-valid round count alone', () => {
    useGameStore.setState({
      phase: 'setup',
      totalRounds: 3,
      players: [{ id: 1, name: 'P1', score: 0 }],
    });
    useGameStore.getState().setPool(pool, 0);
    expect(useGameStore.getState().totalRounds).toBe(3);
  });

  it('does not disturb a match already in progress', () => {
    setup(2, 3);
    useGameStore.getState().setPool(pool.slice(0, 4), 0);

    const state = useGameStore.getState();
    expect(state.phase).toBe('playing');
    expect(state.totalRounds).toBe(3);
    expect(state.matchLocations).toHaveLength(6);
  });
});

describe('roster changes', () => {
  it('will not drop below the minimum player count', () => {
    useGameStore.setState({ players: [{ id: 1, name: 'Solo', score: 0 }] });
    useGameStore.getState().removePlayer(1);
    expect(useGameStore.getState().players).toHaveLength(1);
  });

  it('gives each added player a unique id', () => {
    useGameStore.setState({
      players: [
        { id: 1, name: 'P1', score: 0 },
        { id: 2, name: 'P2', score: 0 },
      ],
    });
    useGameStore.getState().removePlayer(1);
    useGameStore.getState().addPlayer();

    const ids = useGameStore.getState().players.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('scoped matches', () => {
  // A pool with a known shape: 20 European (10 French), 20 North American.
  const scopedPool: GameLocation[] = [
    ...Array.from({ length: 10 }, (_, i) => ({
      ...makeLocation(100 + i),
      answer: {
        continent: 'Europe',
        country: 'France',
        region: `FR-Region${i}`,
        city: `FR-City${i}`,
        street: `FR-Street${i}`,
      },
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      ...makeLocation(200 + i),
      answer: {
        continent: 'Europe',
        country: 'Germany',
        region: `DE-Region${i}`,
        city: `DE-City${i}`,
        street: `DE-Street${i}`,
      },
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      ...makeLocation(300 + i),
      answer: {
        continent: 'North America',
        country: 'United States',
        region: `US-Region${i}`,
        city: `US-City${i}`,
        street: `US-Street${i}`,
      },
    })),
  ];

  function setupScoped(scope: Scope, playerCount = 2, rounds = 3) {
    useGameStore.setState({
      phase: 'setup',
      players: Array.from({ length: playerCount }, (_, i) => ({
        id: i + 1,
        name: `P${i + 1}`,
        score: 0,
      })),
      totalRounds: rounds,
      turnIndex: 0,
      matchLocations: [],
      turnScore: 0,
      turnResult: null,
      pool: scopedPool,
      poolLoaded: true,
    });
    useGameStore.getState().setScope(scope);
    useGameStore.setState({ totalRounds: rounds });
    return useGameStore.getState().startMatch();
  }

  it('deals only from the chosen continent', () => {
    expect(setupScoped({ type: 'continent', value: 'Europe' })).toBe(true);
    const { matchLocations } = useGameStore.getState();
    expect(matchLocations.every((l) => l.answer.continent === 'Europe')).toBe(true);
  });

  it('deals only from the chosen country', () => {
    expect(setupScoped({ type: 'country', value: 'United States' })).toBe(true);
    const { matchLocations } = useGameStore.getState();
    expect(matchLocations.every((l) => l.answer.country === 'United States')).toBe(true);
  });

  it('skips the continent tier in a continent match', () => {
    setupScoped({ type: 'continent', value: 'Europe' });
    expect(useGameStore.getState().currentTier).toBe('country');
  });

  it('skips continent and country in a country match', () => {
    setupScoped({ type: 'country', value: 'United States' });
    expect(useGameStore.getState().currentTier).toBe('region');
  });

  it('caps a perfect continent turn at 14, not 15', () => {
    setupScoped({ type: 'continent', value: 'Europe' });
    for (let i = 0; i < 4; i++) answerCorrectly();
    expect(useGameStore.getState().players[0].score).toBe(14);
    expect(useGameStore.getState().turnResult?.outcome).toBe('perfect');
  });

  it('caps a perfect country turn at 12', () => {
    setupScoped({ type: 'country', value: 'United States' });
    for (let i = 0; i < 3; i++) answerCorrectly();
    expect(useGameStore.getState().players[0].score).toBe(12);
  });

  it('banks relative to the starting tier on a wrong answer', () => {
    setupScoped({ type: 'continent', value: 'Europe' });
    answerCorrectly(); // country, banks 2 rather than 3
    expect(useGameStore.getState().turnScore).toBe(2);
    useGameStore.getState().submitGuess('not a region');
    expect(useGameStore.getState().players[0].score).toBe(2);
  });

  it('returns to the scoped starting tier on the next turn', () => {
    setupScoped({ type: 'country', value: 'United States' });
    useGameStore.getState().submitGuess('wrong');
    useGameStore.getState().nextTurn();
    expect(useGameStore.getState().currentTier).toBe('region');
  });

  it('refuses to start when the scope has too few locations', () => {
    useGameStore.setState({
      phase: 'setup',
      players: [
        { id: 1, name: 'P1', score: 0 },
        { id: 2, name: 'P2', score: 0 },
      ],
      pool: scopedPool,
      totalRounds: 15,
    });
    useGameStore.getState().setScope({ type: 'country', value: 'France' });
    // Only 10 French locations; 2 players x 15 rounds needs 30.
    useGameStore.setState({ totalRounds: 15 });
    expect(useGameStore.getState().startMatch()).toBe(false);
  });

  it('snaps the round count down when a narrower scope cannot support it', () => {
    useGameStore.setState({
      phase: 'setup',
      players: [
        { id: 1, name: 'P1', score: 0 },
        { id: 2, name: 'P2', score: 0 },
      ],
      pool: scopedPool,
      totalRounds: 15,
    });
    useGameStore.getState().setScope({ type: 'country', value: 'France' });
    // 10 locations / 2 players supports 5 rounds.
    expect(useGameStore.getState().totalRounds).toBe(5);
  });

  it('keeps whole-world matches on the full 15-point ladder', () => {
    setupScoped({ type: 'world', value: null });
    expect(useGameStore.getState().currentTier).toBe('continent');
    for (let i = 0; i < 5; i++) answerCorrectly();
    expect(useGameStore.getState().players[0].score).toBe(15);
  });

  it('survives backToSetup with the scope intact', () => {
    setupScoped({ type: 'continent', value: 'Europe' });
    useGameStore.getState().backToSetup();
    const s = useGameStore.getState();
    expect(s.scope).toEqual({ type: 'continent', value: 'Europe' });
    expect(s.currentTier).toBe('country');
  });
});

describe('difficulty', () => {
  /** Twelve locations: 4 easy, 4 medium, 4 hard-only, all in Europe. */
  const mixedPool: GameLocation[] = Array.from({ length: 12 }, (_, i) => ({
    ...makeLocation(i),
    difficulty: (['easy', 'medium', 'hard'] as const)[i % 3],
  }));

  function setupDifficulty(playerCount = 1, rounds = 3) {
    useGameStore.setState({
      phase: 'setup',
      players: Array.from({ length: playerCount }, (_, i) => ({
        id: i + 1,
        name: `P${i + 1}`,
        score: 0,
      })),
      totalRounds: rounds,
      scope: { type: 'world', value: null },
      difficulty: 'hard',
      pool: mixedPool,
      poolLoaded: true,
      turnIndex: 0,
      matchLocations: [],
    });
  }

  it('deals only from the chosen difficulty', () => {
    setupDifficulty(1, 3);
    useGameStore.getState().setDifficulty('easy');
    expect(useGameStore.getState().startMatch()).toBe(true);
    for (const location of useGameStore.getState().matchLocations) {
      expect(location.difficulty).toBe('easy');
    }
  });

  it('deals landmarks and everything else on hard', () => {
    setupDifficulty(1, 3);
    useGameStore.setState({ pool: mixedPool, difficulty: 'hard' });
    expect(useGameStore.getState().matchPool()).toHaveLength(12);
  });

  it('snaps the round count down when a difficulty cannot support it', () => {
    // Ten rounds is fine across twelve locations and impossible across four.
    setupDifficulty(1, 10);
    useGameStore.getState().setDifficulty('easy');
    expect(useGameStore.getState().totalRounds).toBe(3);
  });

  it('refuses to start when the difficulty has too few locations', () => {
    setupDifficulty(2, 3);
    useGameStore.setState({ difficulty: 'easy', totalRounds: 3 });
    // Six turns needed, four easy locations available.
    expect(useGameStore.getState().startMatch()).toBe(false);
  });

  it('survives backToSetup with the difficulty intact', () => {
    setupDifficulty(1, 3);
    useGameStore.getState().setDifficulty('medium');
    useGameStore.getState().startMatch();
    useGameStore.getState().backToSetup();
    expect(useGameStore.getState().difficulty).toBe('medium');
  });

  it('measures available rounds against scope and difficulty together', () => {
    setupDifficulty(1, 3);
    useGameStore.setState({
      pool: [
        ...mixedPool,
        // Four more easy locations, but in Asia.
        ...Array.from({ length: 4 }, (_, i) => ({
          ...makeLocation(100 + i),
          difficulty: 'easy' as const,
          answer: {
            continent: 'Asia',
            country: `AC${i}`,
            region: `AR${i}`,
            city: `ACity${i}`,
            street: `AStreet${i}`,
          },
        })),
      ],
    });

    useGameStore.getState().setDifficulty('easy');
    expect(useGameStore.getState().matchPool()).toHaveLength(8);

    useGameStore.getState().setScope({ type: 'continent', value: 'Europe' });
    expect(useGameStore.getState().matchPool()).toHaveLength(4);
  });
});

describe('round clamping across every input', () => {
  // Four easy locations: enough for a 3-round solo match, not for two players.
  const thinPool: GameLocation[] = [
    ...Array.from({ length: 4 }, (_, i) => ({
      ...makeLocation(i),
      difficulty: 'easy' as const,
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      ...makeLocation(50 + i),
      difficulty: 'hard' as const,
    })),
  ];

  it('re-clamps when the roster changes, not only when the filters do', () => {
    // The dead end this guards: a difficulty too thin to offer ANY round count
    // deliberately keeps the current one, and removing a player then makes a
    // count offerable again. Without a clamp here the setup screen shows a
    // round chip with none selected and a disabled Start, and says nothing -
    // a non-empty chip row suppresses the "too small to play" notice.
    useGameStore.setState({
      phase: 'setup',
      players: [
        { id: 1, name: 'P1', score: 0 },
        { id: 2, name: 'P2', score: 0 },
      ],
      totalRounds: 5,
      scope: { type: 'world', value: null },
      difficulty: 'hard',
      pool: thinPool,
      poolLoaded: true,
    });

    useGameStore.getState().setDifficulty('easy');
    // Two players cannot fill even a 3-round easy match, so 5 is kept.
    expect(useGameStore.getState().availableRounds()).toEqual([]);
    expect(useGameStore.getState().totalRounds).toBe(5);

    useGameStore.getState().removePlayer(2);
    const state = useGameStore.getState();
    expect(state.availableRounds()).toEqual([3]);
    expect(state.availableRounds()).toContain(state.totalRounds);
    expect(state.startMatch()).toBe(true);
  });

  it('clamps when a player is added', () => {
    useGameStore.setState({
      phase: 'setup',
      players: [{ id: 1, name: 'P1', score: 0 }],
      totalRounds: 15,
      scope: { type: 'world', value: null },
      difficulty: 'hard',
      pool: thinPool,
      poolLoaded: true,
    });

    useGameStore.getState().addPlayer();
    const state = useGameStore.getState();
    expect(state.availableRounds()).toContain(state.totalRounds);
  });
});
