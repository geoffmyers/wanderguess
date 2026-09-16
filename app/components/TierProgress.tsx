'use client';

import { Fragment } from 'react';

import { getLiveTiers } from '@/lib/game/scoring';
import type { TierId } from '@/lib/types/location';

interface Props {
  currentTier: TierId;
  /** First tier in play; earlier ones are given by the scope and not shown. */
  startTier: TierId;
}

/** Shows how far into the tiers still in play this turn has climbed. */
export default function TierProgress({ currentTier, startTier }: Props) {
  const tiers = getLiveTiers(startTier);
  const currentIndex = tiers.findIndex((t) => t.id === currentTier);

  return (
    <div className="tier-progress" aria-label="Turn progress">
      {tiers.map((tier, index) => {
        const state =
          index < currentIndex ? 'done' : index === currentIndex ? 'current' : '';
        return (
          <Fragment key={tier.id}>
            {index > 0 && <span className="tier-connector" />}
            <span className={`tier-dot ${state}`.trim()}>
              <span className="dot" />
              <span>{tier.label}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
