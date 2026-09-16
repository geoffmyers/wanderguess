'use client';

import { getPerfectRoundScore, getStartTier } from '@/lib/game/scoring';
import useGameStore from '@/lib/game/store';
import { determineWinners, rankPlayers } from '@/lib/game/turns';

export default function VictoryScreen() {
  const players = useGameStore((s) => s.players);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const scope = useGameStore((s) => s.scope);
  const backToSetup = useGameStore((s) => s.backToSetup);
  const rematch = useGameStore((s) => s.rematch);

  const ranked = rankPlayers(players);
  const winners = determineWinners(players);
  const winnerIds = new Set(winners.map((w) => w.id));
  const shared = winners.length > 1;
  const solo = players.length === 1;
  // Scope-aware: a Europe match tops out at 9 a turn, a country match at 7.
  const maxPossible = getPerfectRoundScore(getStartTier(scope)) * totalRounds;

  const heading = solo
    ? `${players[0].score} out of ${maxPossible}`
    : shared
      ? `${winners.map((w) => w.name).join(' and ')} tie`
      : `${winners[0]?.name} wins`;

  return (
    <main className="centered">
      <div className="overlay-card">
        <p className="result-badge good">
          {totalRounds} round{totalRounds === 1 ? '' : 's'} complete
        </p>
        <h2>{heading}</h2>

        {solo && (
          <p className="answer-sub">
            {players[0].score === maxPossible
              ? 'A flawless run.'
              : `${maxPossible - players[0].score} points left on the table.`}
          </p>
        )}

        <div className="standings">
          {ranked.map((player, index) => (
            <div
              key={player.id}
              className={`standing-row${winnerIds.has(player.id) ? ' winner' : ''}`}
            >
              <span className="rank">{index + 1}</span>
              <span className="who">{player.name}</span>
              <span className="pts">{player.score}</span>
            </div>
          ))}
        </div>

        <div className="button-row">
          <button type="button" className="secondary-button" onClick={backToSetup}>
            Change setup
          </button>
          <button type="button" className="primary-button" onClick={rematch}>
            Play again
          </button>
        </div>
      </div>
    </main>
  );
}
