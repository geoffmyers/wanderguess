'use client';

import { GAME } from '@/lib/game/constants';
import useGameStore from '@/lib/game/store';

export default function PoolMissingScreen() {
  const poolSize = useGameStore((s) => s.pool.length);
  const dropped = useGameStore((s) => s.poolDropped);

  return (
    <main className="centered">
      <div className="panel">
        <h1>No locations yet</h1>
        <p className="subtitle">
          Wanderguess plays from a pool of curated Mapillary panoramas that is
          generated locally rather than committed blank.
        </p>

        <div className="notice">
          Build one with a free Mapillary token:
          <br />
          <br />
          <code>cp .env.example .env</code> (then set your token in it)
          <br />
          <code>npm run build-pool</code>
          <br />
          <br />
          That writes <code>public/data/locations.json</code>. Get a token at{' '}
          <a
            href="https://www.mapillary.com/dashboard/developers"
            target="_blank"
            rel="noreferrer noopener"
          >
            mapillary.com/dashboard/developers
          </a>
          .
        </div>

        {poolSize > 0 && (
          <p className="banked" style={{ marginTop: 16 }}>
            Found {poolSize} playable location{poolSize === 1 ? '' : 's'}, but at
            least {GAME.minPoolSize} are needed.
          </p>
        )}
        {dropped > 0 && (
          <p className="banked" style={{ marginTop: 6 }}>
            {dropped} entr{dropped === 1 ? 'y was' : 'ies were'} rejected as
            incomplete — rerun the pool builder to replace them.
          </p>
        )}
      </div>
    </main>
  );
}
