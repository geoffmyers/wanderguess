'use client';

import useGameStore from '@/lib/game/store';
import { playerIndexForTurn } from '@/lib/game/turns';

/**
 * Horizontal strip of player scores. Scrolls rather than wraps so a roster of
 * eight stays on one line and the active player keeps a stable position.
 */
export default function ScoreRail() {
  const players = useGameStore((s) => s.players);
  const turnIndex = useGameStore((s) => s.turnIndex);

  const activeIndex = playerIndexForTurn(turnIndex, players.length);

  return (
    <div className="score-rail" role="list" aria-label="Scores">
      {players.map((player, index) => (
        <div
          role="listitem"
          key={player.id}
          className={`score-card${index === activeIndex ? ' active' : ''}`}
          aria-current={index === activeIndex ? 'true' : undefined}
        >
          <span className="name">{player.name}</span>
          <span className="score">{player.score}</span>
        </div>
      ))}
    </div>
  );
}
