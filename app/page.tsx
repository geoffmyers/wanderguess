'use client';

import { useEffect, useState } from 'react';

import GameBoard from './components/GameBoard';
import PoolMissingScreen from './components/PoolMissingScreen';
import SetupScreen from './components/SetupScreen';
import VictoryScreen from './components/VictoryScreen';

import { MANIFEST_URL } from '@/lib/game/constants';
import { loadPoolFromManifest } from '@/lib/game/pool';
import useGameStore from '@/lib/game/store';
import type { LocationManifest } from '@/lib/types/location';

export default function Page() {
  // Gate the first paint on mount so the static export's server-rendered HTML
  // and the client's first render agree, whatever localStorage happens to hold.
  const [mounted, setMounted] = useState(false);
  const phase = useGameStore((s) => s.phase);
  const poolLoaded = useGameStore((s) => s.poolLoaded);
  const setPool = useGameStore((s) => s.setPool);
  const setPoolMissing = useGameStore((s) => s.setPoolMissing);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(MANIFEST_URL, { signal: controller.signal });
        if (!response.ok) throw new Error(`Manifest returned ${response.status}`);
        const manifest = (await response.json()) as LocationManifest;
        const { locations, dropped } = loadPoolFromManifest(manifest);
        setPool(locations, dropped);
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') return;
        setPoolMissing();
      }
    })();

    return () => controller.abort();
  }, [setPool, setPoolMissing]);

  if (!mounted || !poolLoaded) {
    return (
      <main className="centered">
        <div className="spinner" />
      </main>
    );
  }

  switch (phase) {
    case 'pool_missing':
      return <PoolMissingScreen />;
    case 'playing':
    case 'reveal':
      return <GameBoard />;
    case 'victory':
      return <VictoryScreen />;
    default:
      return <SetupScreen />;
  }
}
