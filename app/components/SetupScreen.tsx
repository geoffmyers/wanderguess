'use client';

import Credits from './Credits';
import DifficultyPicker from './DifficultyPicker';
import ScopePicker from './ScopePicker';

import { DIFFICULTIES, GAME } from '@/lib/game/constants';
import { diagnosePoolShortfall, filterPool } from '@/lib/game/pool';
import { getLiveTiers, getPerfectRoundScore, getStartTier } from '@/lib/game/scoring';
import useGameStore from '@/lib/game/store';
import { maxRoundsForPool, minimumMatchLocations, totalTurns } from '@/lib/game/turns';

export default function SetupScreen() {
  const players = useGameStore((s) => s.players);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const pool = useGameStore((s) => s.pool);
  const scope = useGameStore((s) => s.scope);
  const difficulty = useGameStore((s) => s.difficulty);
  const addPlayer = useGameStore((s) => s.addPlayer);
  const removePlayer = useGameStore((s) => s.removePlayer);
  const setPlayerName = useGameStore((s) => s.setPlayerName);
  const setTotalRounds = useGameStore((s) => s.setTotalRounds);
  const startMatch = useGameStore((s) => s.startMatch);

  // Each player needs a distinct location every round, so the roster size caps
  // how long a match can run before the pool would have to repeat itself. The
  // filtered pool is what counts - a Europe match only draws European
  // locations, and an Easy match only ones that carry a landmark.
  const poolSize = filterPool(pool, scope, difficulty).length;
  const maxRounds = maxRoundsForPool(poolSize, players.length);
  const roundChoices = GAME.roundOptions.filter((r: number) => r <= maxRounds);
  const canStart = roundChoices.length > 0 && totalRounds <= maxRounds;

  // Scope and difficulty are independent, so either can empty the pool on its
  // own and the combination can empty it when neither is unreasonable alone.
  // Saying which one is responsible is the difference between a settings
  // problem the player can fix and something that reads like a bug.
  const shortfall = diagnosePoolShortfall(
    pool,
    scope,
    difficulty,
    minimumMatchLocations(players.length)
  );
  const difficultyLabel =
    DIFFICULTIES.find((d) => d.id === difficulty)?.label ?? difficulty;

  const startTier = getStartTier(scope);
  const liveTiers = getLiveTiers(startTier);
  const perfect = getPerfectRoundScore(startTier);

  return (
    <main className="centered">
      <div className="panel">
        <h1>Wanderguess</h1>
        <p className="subtitle">
          Look around a street-level panorama from somewhere in the world, then
          narrow down where it is. Each correct step is worth more than the last.
        </p>

        <div className="section">
          <span className="section-label">
            Players ({players.length} of {GAME.maxPlayers})
          </span>
          {players.map((player, index) => (
            <div className="player-row" key={player.id}>
              <input
                value={player.name}
                maxLength={20}
                aria-label={`Name for player ${index + 1}`}
                onChange={(e) => setPlayerName(player.id, e.target.value)}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${player.name}`}
                disabled={players.length <= GAME.minPlayers}
                onClick={() => removePlayer(player.id)}
              >
                ×
              </button>
            </div>
          ))}
          {players.length < GAME.maxPlayers && (
            <button type="button" className="text-button" onClick={addPlayer}>
              + Add player
            </button>
          )}
        </div>

        <ScopePicker />

        <DifficultyPicker />

        <div className="section">
          <span className="section-label">Rounds</span>
          <div className="chip-row">
            {roundChoices.map((rounds: number) => (
              <button
                type="button"
                key={rounds}
                className={`chip${rounds === totalRounds ? ' selected' : ''}`}
                onClick={() => setTotalRounds(rounds)}
              >
                {rounds}
              </button>
            ))}
          </div>
          {canStart && (
            <p className="banked" style={{ marginTop: 8 }}>
              {totalTurns(players.length, totalRounds)} locations, one per turn —
              nobody sees the same place twice.
            </p>
          )}
          {roundChoices.length === 0 && (
            <p className="notice" style={{ marginTop: 8 }}>
              {shortfall === 'difficulty' &&
                `${difficultyLabel} has only ${poolSize} location${
                  poolSize === 1 ? '' : 's'
                }${scope.type === 'world' ? '' : ` in ${scope.value}`}, too few for ${
                  players.length
                } players. Another difficulty would work here.`}
              {shortfall === 'scope' &&
                `${scope.value} has only ${poolSize} ${difficultyLabel.toLowerCase()} location${
                  poolSize === 1 ? '' : 's'
                }, too few for ${players.length} players. Somewhere else would work on ${difficultyLabel}.`}
              {shortfall === 'both' &&
                `${difficultyLabel}${
                  scope.type === 'world' ? '' : ` in ${scope.value}`
                } holds ${poolSize} location${
                  poolSize === 1 ? '' : 's'
                }, too few for ${players.length} players. Widening either the difficulty or where in the world would help.`}
              {shortfall === 'pool' &&
                `The whole location pool (${pool.length}) is too small for ${players.length} players.`}{' '}
              Remove a player, or rebuild the pool with <code>npm run build-pool</code>.
            </p>
          )}
        </div>

        <div className="section">
          <span className="section-label">Scoring</span>
          <table className="scoring-table">
            <tbody>
              {liveTiers.map((tier) => (
                <tr key={tier.id}>
                  <td>{tier.label}</td>
                  <td>+{tier.points}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Perfect turn</strong>
                </td>
                <td>{perfect}</td>
              </tr>
            </tbody>
          </table>
          <p className="banked" style={{ marginTop: 8 }}>
            A wrong answer ends your turn but you keep everything banked so far.
          </p>
        </div>

        <button
          type="button"
          className="primary-button"
          disabled={!canStart}
          onClick={() => startMatch()}
        >
          Start match
        </button>

        <Credits />
      </div>
    </main>
  );
}
