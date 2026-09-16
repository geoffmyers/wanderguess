'use client';

import { DIFFICULTIES } from '@/lib/game/constants';
import { getAvailableDifficulties } from '@/lib/game/pool';
import useGameStore from '@/lib/game/store';
import { minimumMatchLocations } from '@/lib/game/turns';
import type { Difficulty } from '@/lib/types/location';

/**
 * Chooses how hard the locations are, independently of where they are.
 *
 * Counts are shown per mode *within the current scope*, because that is the
 * number that decides whether a mode is playable: Easy may hold ninety
 * locations worldwide and none at all in a Japan match, and offering it as
 * though it had ninety would be an invitation to a dead end.
 */
export default function DifficultyPicker() {
  const pool = useGameStore((s) => s.pool);
  const scope = useGameStore((s) => s.scope);
  const players = useGameStore((s) => s.players);
  const difficulty = useGameStore((s) => s.difficulty);
  const setDifficulty = useGameStore((s) => s.setDifficulty);

  const counts = new Map(getAvailableDifficulties(pool, scope).map((d) => [d.id, d.count]));

  // A mode is only playable if it can fill one round for this roster. Thin
  // modes stay selectable rather than being hidden the way thin scopes are:
  // picking one and being told which of the two filters emptied the pool is
  // more use than a chip that is silently gone.
  const minimumNeeded = minimumMatchLocations(players.length);
  const selected = DIFFICULTIES.find((d) => d.id === difficulty);

  return (
    <div className="section">
      <span className="section-label">How hard?</span>

      <div className="chip-row">
        {DIFFICULTIES.map((mode) => {
          const count = counts.get(mode.id) ?? 0;
          const playable = count >= minimumNeeded;
          return (
            <button
              type="button"
              key={mode.id}
              className={`chip${mode.id === difficulty ? ' selected' : ''}${
                playable ? '' : ' thin'
              }`}
              title={
                playable
                  ? mode.blurb
                  : `${mode.label} has ${count} location${count === 1 ? '' : 's'} here`
              }
              onClick={() => setDifficulty(mode.id as Difficulty)}
            >
              {mode.label} ({count})
            </button>
          );
        })}
      </div>

      {selected && (
        <p className="banked" style={{ marginTop: 10 }}>
          {selected.blurb}
        </p>
      )}
    </div>
  );
}
