'use client';

import { getTier } from '@/lib/game/scoring';
import useGameStore, { formatAnswer } from '@/lib/game/store';
import { isMatchOver } from '@/lib/game/turns';
import type { TurnResult } from '@/lib/types/game';

interface Props {
  result: TurnResult;
}

export default function RevealOverlay({ result }: Props) {
  const players = useGameStore((s) => s.players);
  const turnIndex = useGameStore((s) => s.turnIndex);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const nextTurn = useGameStore((s) => s.nextTurn);

  const player = players.find((p) => p.id === result.playerId);
  const perfect = result.outcome === 'perfect';
  const lastTurn = isMatchOver(turnIndex + 1, players.length, totalRounds);
  const { location } = result;

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay-card">
        <p className={`result-badge ${perfect ? 'good' : 'bad'}`}>
          {perfect ? 'Perfect turn' : `Missed the ${getTier(result.failedTier!).label.toLowerCase()}`}
        </p>

        <h2>{player?.name}</h2>

        <p className="answer-line">{formatAnswer(location.answer)}</p>
        <p className="answer-sub">
          {/* Naming the landmark is what makes a missed easy round instructive
              rather than merely lost - the player learns what they were looking
              at, which is the whole reason the round opened facing it. */}
          {location.landmark ? `${location.landmark} · ` : ''}
          {location.answer.continent} · captured {location.capturedAt}
        </p>

        <p className="points-earned">
          +{result.pointsEarned} point{result.pointsEarned === 1 ? '' : 's'}
        </p>

        <div>
          <a
            className="map-link"
            href={`https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lon}#map=13/${location.lat}/${location.lon}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            See it on the map →
          </a>
        </div>

        <button type="button" className="primary-button" onClick={nextTurn}>
          {lastTurn ? 'Final scores' : 'Next player'}
        </button>
      </div>
    </div>
  );
}
