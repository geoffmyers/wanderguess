'use client';

import { GAME } from '@/lib/game/constants';
import { filterPoolByDifficulty, getAvailableScopes } from '@/lib/game/pool';
import { getLiveTiers, getPerfectRoundScore, getStartTier } from '@/lib/game/scoring';
import useGameStore from '@/lib/game/store';
import { maxRoundsForPool, minimumMatchLocations } from '@/lib/game/turns';
import type { Scope, ScopeType } from '@/lib/types/game';

/**
 * Chooses which part of the world a match is drawn from.
 *
 * Narrowing the scope also removes the tiers it gives away, so the picker shows
 * what a perfect turn becomes - otherwise a player picking "United States"
 * would have no idea why turns are suddenly worth 7 instead of 10.
 */
export default function ScopePicker() {
  const pool = useGameStore((s) => s.pool);
  const players = useGameStore((s) => s.players);
  const scope = useGameStore((s) => s.scope);
  const difficulty = useGameStore((s) => s.difficulty);
  const setScope = useGameStore((s) => s.setScope);

  // Counted within the chosen difficulty, because that is what the scope will
  // actually deliver: "Japan (14)" is a lie in Easy mode if only two of those
  // fourteen carry a landmark.
  const { continents, countries } = getAvailableScopes(
    filterPoolByDifficulty(pool, difficulty)
  );

  // A scope is only offerable if it can fill the shortest match this roster can
  // play. Offering one that fills a single round leaves the setup screen with
  // no round chip to select and a dead Start button.
  const minimumNeeded = minimumMatchLocations(players.length);
  const usableContinents = continents.filter((c) => c.count >= minimumNeeded);
  const usableCountries = countries.filter((c) => c.count >= minimumNeeded);

  const startTier = getStartTier(scope);
  const perfect = getPerfectRoundScore(startTier);
  const liveTiers = getLiveTiers(startTier);

  const choose = (type: ScopeType, value: string | null) => {
    const next: Scope = { type, value };
    setScope(next);
  };

  const typeChip = (type: ScopeType, label: string, enabled: boolean) => (
    <button
      type="button"
      key={type}
      className={`chip${scope.type === type ? ' selected' : ''}`}
      disabled={!enabled}
      onClick={() => {
        if (type === 'world') return choose('world', null);
        const first = type === 'continent' ? usableContinents[0] : usableCountries[0];
        choose(type, first?.value ?? null);
      }}
    >
      {label}
    </button>
  );

  const values = scope.type === 'continent' ? usableContinents : usableCountries;

  return (
    <div className="section">
      <span className="section-label">Where in the world?</span>

      <div className="chip-row">
        {typeChip('world', 'Anywhere', true)}
        {typeChip('continent', 'One continent', usableContinents.length > 0)}
        {typeChip('country', 'One country', usableCountries.length > 0)}
      </div>

      {scope.type !== 'world' && (
        <div className="chip-row" style={{ marginTop: 10 }}>
          {values.map((option) => (
            <button
              type="button"
              key={option.value}
              className={`chip${scope.value === option.value ? ' selected' : ''}`}
              onClick={() => choose(scope.type, option.value)}
            >
              {option.value} ({option.count})
            </button>
          ))}
        </div>
      )}

      <p className="banked" style={{ marginTop: 10 }}>
        {scope.type === 'world'
          ? `Guessing ${liveTiers.map((t) => t.label.toLowerCase()).join(' → ')} — ${perfect} a turn.`
          : `${scope.value} is given, so you guess ${liveTiers
              .map((t) => t.label.toLowerCase())
              .join(' → ')} — ${perfect} a turn.`}
      </p>

      {(usableContinents.length < continents.length ||
        usableCountries.length < countries.length) && (
        <p className="notice" style={{ marginTop: 8 }}>
          Some places are hidden because they hold fewer than {minimumNeeded} location
          {minimumNeeded === 1 ? '' : 's'} — the shortest match needs one per player per
          round. Fewer players, an easier difficulty, or a larger pool from{' '}
          <code>npm run build-pool</code> will unlock them.
        </p>
      )}
    </div>
  );
}

/** Round options this scope can support, for the setup screen to render. */
export function roundsForScope(poolSize: number, playerCount: number): number[] {
  const max = maxRoundsForPool(poolSize, playerCount);
  return GAME.roundOptions.filter((r: number) => r <= max);
}
