'use client';

import TierProgress from './TierProgress';

import { getStartTier, getTier } from '@/lib/game/scoring';
import useGameStore from '@/lib/game/store';

export default function GuessTray() {
  const currentTier = useGameStore((s) => s.currentTier);
  const options = useGameStore((s) => s.currentOptions);
  const turnScore = useGameStore((s) => s.turnScore);
  const feedbackMessage = useGameStore((s) => s.feedbackMessage);
  const submitGuess = useGameStore((s) => s.submitGuess);
  const scope = useGameStore((s) => s.scope);

  const tier = getTier(currentTier);
  const startTier = getStartTier(scope);

  return (
    <div className="guess-tray">
      <TierProgress currentTier={currentTier} startTier={startTier} />

      <div className="guess-prompt">
        <h2>
          {scope.type !== 'world' && <span className="scope-given">{scope.value}</span>}
          {tier.question}
        </h2>
        <span className="worth">worth {tier.points}</span>
      </div>

      {turnScore > 0 && (
        <p className="banked" style={{ marginBottom: 10 }}>
          {turnScore} point{turnScore === 1 ? '' : 's'} banked — a wrong answer
          now keeps {turnScore}.
        </p>
      )}

      {/* Widened from the content rather than from the tier id: street names
          run to "Boulevard Valery Giscard d'Estaing", which shreds a 140px
          column, but so does the occasional long city or region. Keying on the
          text keeps the rule out of the tier list. */}
      <div className={`option-grid${options.some((o) => o.length > 18) ? ' wide' : ''}`}>
        {options.map((option) => (
          <button
            type="button"
            key={option}
            className="option-button"
            onClick={() => submitGuess(option)}
          >
            {option}
          </button>
        ))}
      </div>

      {feedbackMessage && <p className="toast">{feedbackMessage}</p>}
    </div>
  );
}
