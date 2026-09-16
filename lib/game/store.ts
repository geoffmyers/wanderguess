import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { DEFAULT_DIFFICULTY, GAME } from './constants';
import { buildTierOptions, filterPool, selectMatchLocations } from './pool';
import {
  formatAnswer,
  getBankedScore,
  getNextTier,
  getPerfectRoundScore,
  getStartTier,
  getTier,
  isCorrectGuess,
} from './scoring';
import {
  determineWinners,
  isMatchOver,
  maxRoundsForPool,
  playerIndexForTurn,
  roundForTurn,
  totalTurns,
} from './turns';

import type { GamePhase, Player, Scope, TurnResult } from '@/lib/types/game';
import type { Difficulty, GameLocation, TierId } from '@/lib/types/location';

interface GameState {
  phase: GamePhase;
  players: Player[];
  totalRounds: number;
  /** Restricts the match to a continent or country, and skips the tiers it gives away. */
  scope: Scope;
  /** Restricts the match to landmark, major-city or any locations. Orthogonal to scope. */
  difficulty: Difficulty;

  /** Single source of truth for position in the match; player and round derive from it. */
  turnIndex: number;
  /** One distinct location per turn, chosen when the match starts. */
  matchLocations: GameLocation[];

  currentTier: TierId;
  currentOptions: string[];
  /** Points banked in this turn so far, awarded when the turn ends. */
  turnScore: number;

  lastGuess: string | null;
  lastGuessCorrect: boolean | null;
  feedbackMessage: string;
  turnResult: TurnResult | null;

  /** Loaded manifest. Not persisted - refetched on each visit. */
  pool: GameLocation[];
  poolDropped: number;
  poolLoaded: boolean;
}

interface GameActions {
  setPool: (locations: GameLocation[], dropped: number) => void;
  setPoolMissing: () => void;

  addPlayer: () => void;
  removePlayer: (playerId: number) => void;
  setPlayerName: (playerId: number, name: string) => void;
  setTotalRounds: (rounds: number) => void;
  setScope: (scope: Scope) => void;
  setDifficulty: (difficulty: Difficulty) => void;

  startMatch: () => boolean;
  submitGuess: (value: string) => void;
  nextTurn: () => void;
  backToSetup: () => void;
  rematch: () => void;

  currentPlayer: () => Player | null;
  currentLocation: () => GameLocation | null;
  currentRound: () => number;
  availableRounds: () => number[];
  winners: () => Player[];
  /** Locations the current scope and difficulty both admit - what a match deals from. */
  matchPool: () => GameLocation[];
  /** The first tier players actually guess under the current scope. */
  startTier: () => TierId;
  /** Most one turn can be worth under the current scope: 15 world, 14 continent, 12 country. */
  perfectRoundScore: () => number;
}

const WORLD_SCOPE: Scope = { type: 'world', value: null };

/**
 * Bumped whenever the tier ladder changes, so a match dealt under the old rules
 * is abandoned rather than resumed into a round it cannot answer. 2 = the
 * street tier.
 */
const STORAGE_VERSION = 2;

const defaultPlayers = (): Player[] => [
  { id: 1, name: 'Player 1', score: 0 },
  { id: 2, name: 'Player 2', score: 0 },
];

/**
 * The round count to keep after the pool a match can draw from has changed.
 *
 * Narrowing either filter can strand a round count the new pool cannot support,
 * so it snaps down - but to a still-offered option rather than to the raw
 * maximum, or the setup screen would show no selected chip while Start stayed
 * enabled. When nothing fits, the current value is kept: the setup screen has
 * its own "too small to play" path, and silently rewriting the number as well
 * would hide which setting caused it.
 */
function clampRounds(
  pool: readonly GameLocation[],
  scope: Scope,
  difficulty: Difficulty,
  playerCount: number,
  currentRounds: number
): number {
  const size = filterPool(pool, scope, difficulty).length;
  const fitting = GAME.roundOptions.filter(
    (r: number) => r <= maxRoundsForPool(size, playerCount)
  );
  if (fitting.includes(currentRounds)) return currentRounds;
  return fitting.length > 0 ? Math.max(...fitting) : currentRounds;
}

const initialState: GameState = {
  phase: 'setup',
  players: defaultPlayers(),
  totalRounds: GAME.defaultRounds,
  scope: WORLD_SCOPE,
  difficulty: DEFAULT_DIFFICULTY,
  turnIndex: 0,
  matchLocations: [],
  currentTier: getStartTier(WORLD_SCOPE),
  currentOptions: [],
  turnScore: 0,
  lastGuess: null,
  lastGuessCorrect: null,
  feedbackMessage: '',
  turnResult: null,
  pool: [],
  poolDropped: 0,
  poolLoaded: false,
};

const useGameStore = create<GameState & GameActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      setPool: (locations, dropped) => {
        const state = get();
        const usable = locations.length >= GAME.minPoolSize;

        // A match already in progress runs entirely from matchLocations, so it
        // must not be disturbed - only the pre-match screens react to the pool.
        const inPreMatch = state.phase === 'setup' || state.phase === 'pool_missing';

        if (!inPreMatch) {
          set({ pool: locations, poolDropped: dropped, poolLoaded: true });
          return;
        }

        // Measured against the pool the match would actually draw from, not the
        // whole one - a Europe match can only run as many rounds as European
        // locations allow, and an Easy match only as many as carry a landmark.
        const totalRounds = usable
          ? clampRounds(
              locations,
              state.scope,
              state.difficulty,
              state.players.length,
              state.totalRounds
            )
          : state.totalRounds;

        set({
          pool: locations,
          poolDropped: dropped,
          poolLoaded: true,
          phase: usable ? 'setup' : 'pool_missing',
          totalRounds,
        });
      },

      setPoolMissing: () => set({ poolLoaded: true, pool: [], phase: 'pool_missing' }),

      // The roster is the third input to how many rounds fit, alongside the two
      // filters, so it has to clamp for the same reason they do. Missing it left
      // a reachable dead end: pick a difficulty too thin to offer any round
      // count (which keeps the current one, deliberately), then remove a player
      // so a count becomes offerable again - and the setup screen showed a round
      // chip with none selected and Start disabled, with no message, because a
      // non-empty chip row suppresses the "too small to play" notice.
      addPlayer: () => {
        const state = get();
        if (state.players.length >= GAME.maxPlayers) return;
        const nextId = state.players.reduce((max, p) => Math.max(max, p.id), 0) + 1;
        const players = [
          ...state.players,
          { id: nextId, name: `Player ${state.players.length + 1}`, score: 0 },
        ];
        set({
          players,
          totalRounds: clampRounds(
            state.pool,
            state.scope,
            state.difficulty,
            players.length,
            state.totalRounds
          ),
        });
      },

      removePlayer: (playerId) => {
        const state = get();
        if (state.players.length <= GAME.minPlayers) return;
        const players = state.players.filter((p) => p.id !== playerId);
        set({
          players,
          totalRounds: clampRounds(
            state.pool,
            state.scope,
            state.difficulty,
            players.length,
            state.totalRounds
          ),
        });
      },

      setPlayerName: (playerId, name) =>
        set((state) => ({
          players: state.players.map((p) => (p.id === playerId ? { ...p, name } : p)),
        })),

      setTotalRounds: (rounds) => set({ totalRounds: rounds }),

      setScope: (scope) => {
        const state = get();
        set({
          scope,
          totalRounds: clampRounds(
            state.pool,
            scope,
            state.difficulty,
            state.players.length,
            state.totalRounds
          ),
        });
      },

      setDifficulty: (difficulty) => {
        const state = get();
        set({
          difficulty,
          totalRounds: clampRounds(
            state.pool,
            state.scope,
            difficulty,
            state.players.length,
            state.totalRounds
          ),
        });
      },

      startMatch: () => {
        const { pool, players, totalRounds, scope, difficulty } = get();
        const needed = totalTurns(players.length, totalRounds);
        const playable = filterPool(pool, scope, difficulty);
        if (playable.length < needed) return false;

        const matchLocations = selectMatchLocations(playable, needed);
        const firstTier = getStartTier(scope);

        set({
          phase: 'playing',
          players: players.map((p) => ({ ...p, score: 0 })),
          turnIndex: 0,
          matchLocations,
          currentTier: firstTier,
          currentOptions: buildTierOptions(matchLocations[0], firstTier),
          turnScore: 0,
          lastGuess: null,
          lastGuessCorrect: null,
          feedbackMessage: '',
          turnResult: null,
        });
        return true;
      },

      submitGuess: (value) => {
        const state = get();
        const location = state.matchLocations[state.turnIndex];
        if (!location || state.phase !== 'playing') return;

        const playerIndex = playerIndexForTurn(state.turnIndex, state.players.length);
        const correct = isCorrectGuess(value, location.answer, state.currentTier);

        if (!correct) {
          // The turn ends here, but everything banked on earlier tiers is kept.
          const earned = state.turnScore;
          set({
            phase: 'reveal',
            players: state.players.map((p, i) =>
              i === playerIndex ? { ...p, score: p.score + earned } : p
            ),
            lastGuess: value,
            lastGuessCorrect: false,
            feedbackMessage: '',
            turnResult: {
              playerId: state.players[playerIndex].id,
              location,
              outcome: 'wrong',
              failedTier: state.currentTier,
              pointsEarned: earned,
            },
          });
          return;
        }

        // Banked relative to the starting tier: in a Europe match the country
        // tier is worth 2, not 3, because the continent point was never offered.
        const banked = getBankedScore(state.currentTier, getStartTier(state.scope));
        const nextTier = getNextTier(state.currentTier);

        if (nextTier) {
          set({
            currentTier: nextTier,
            currentOptions: buildTierOptions(location, nextTier),
            turnScore: banked,
            lastGuess: value,
            lastGuessCorrect: true,
            feedbackMessage: `${value} is right - ${banked} banked. Now the ${getTier(
              nextTier
            ).label.toLowerCase()}.`,
          });
          return;
        }

        // Cleared every tier.
        set({
          phase: 'reveal',
          players: state.players.map((p, i) =>
            i === playerIndex ? { ...p, score: p.score + banked } : p
          ),
          turnScore: banked,
          lastGuess: value,
          lastGuessCorrect: true,
          feedbackMessage: '',
          turnResult: {
            playerId: state.players[playerIndex].id,
            location,
            outcome: 'perfect',
            failedTier: null,
            pointsEarned: banked,
          },
        });
      },

      nextTurn: () => {
        const state = get();
        const nextIndex = state.turnIndex + 1;

        if (isMatchOver(nextIndex, state.players.length, state.totalRounds)) {
          set({ phase: 'victory', turnResult: null, feedbackMessage: '' });
          return;
        }

        const location = state.matchLocations[nextIndex];
        const firstTier = getStartTier(state.scope);
        set({
          phase: 'playing',
          turnIndex: nextIndex,
          currentTier: firstTier,
          currentOptions: buildTierOptions(location, firstTier),
          turnScore: 0,
          lastGuess: null,
          lastGuessCorrect: null,
          feedbackMessage: '',
          turnResult: null,
        });
      },

      backToSetup: () =>
        set((state) => ({
          ...initialState,
          players: state.players.map((p) => ({ ...p, score: 0 })),
          totalRounds: state.totalRounds,
          scope: state.scope,
          difficulty: state.difficulty,
          currentTier: getStartTier(state.scope),
          pool: state.pool,
          poolDropped: state.poolDropped,
          poolLoaded: state.poolLoaded,
        })),

      rematch: () => {
        get().backToSetup();
        get().startMatch();
      },

      currentPlayer: () => {
        const { players, turnIndex } = get();
        if (players.length === 0) return null;
        return players[playerIndexForTurn(turnIndex, players.length)] ?? null;
      },

      currentLocation: () => {
        const { matchLocations, turnIndex } = get();
        return matchLocations[turnIndex] ?? null;
      },

      currentRound: () => {
        const { players, turnIndex } = get();
        if (players.length === 0) return 1;
        return roundForTurn(turnIndex, players.length);
      },

      /** Round choices this filtered pool and roster can actually support. */
      availableRounds: () => {
        const { pool, players, scope, difficulty } = get();
        const max = maxRoundsForPool(
          filterPool(pool, scope, difficulty).length,
          players.length
        );
        return GAME.roundOptions.filter((r: number) => r <= max);
      },

      winners: () => determineWinners(get().players),

      matchPool: () => filterPool(get().pool, get().scope, get().difficulty),

      startTier: () => getStartTier(get().scope),

      perfectRoundScore: () => getPerfectRoundScore(getStartTier(get().scope)),
    }),
    {
      name: 'wanderguess-storage',
      storage: createJSONStorage(() => localStorage),
      // The pool is refetched on every visit; everything else resumes a match.
      partialize: (state) => ({
        phase: state.phase,
        players: state.players,
        totalRounds: state.totalRounds,
        scope: state.scope,
        difficulty: state.difficulty,
        turnIndex: state.turnIndex,
        matchLocations: state.matchLocations,
        currentTier: state.currentTier,
        currentOptions: state.currentOptions,
        turnScore: state.turnScore,
        lastGuess: state.lastGuess,
        lastGuessCorrect: state.lastGuessCorrect,
        feedbackMessage: state.feedbackMessage,
        turnResult: state.turnResult,
      }),

      /**
       * A match dealt before the tier ladder changed cannot be finished.
       *
       * `matchLocations` is persisted so a refresh resumes a match, which means
       * a player mid-match when a new tier ships resumes onto locations that
       * have no answer for it. The ladder comes from config, so the round is
       * asked anyway, `isCorrectGuess` compares against undefined, and every
       * option is wrong - the turn dies at the new tier for the rest of the
       * match with no way to see why.
       *
       * Abandoning the match back to setup is the honest response: the rules
       * changed underneath it. Players, scope, difficulty and round count are
       * kept, so it costs a click rather than a re-setup.
       */
      version: STORAGE_VERSION,
      migrate: (persisted, from) => {
        const state = persisted as Partial<GameState>;
        if (from >= STORAGE_VERSION) return state;
        return {
          ...state,
          phase: 'setup' as GamePhase,
          turnIndex: 0,
          matchLocations: [],
          currentOptions: [],
          turnScore: 0,
          turnResult: null,
          lastGuess: null,
          lastGuessCorrect: null,
          feedbackMessage: '',
          currentTier: getStartTier(state.scope ?? WORLD_SCOPE),
        };
      },
    }
  )
);

export { formatAnswer };
export default useGameStore;
