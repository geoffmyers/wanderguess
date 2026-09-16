'use client';

import AttributionBar from './AttributionBar';
import GuessTray from './GuessTray';
import PanoramaViewer from './PanoramaViewer';
import RevealOverlay from './RevealOverlay';
import ScoreRail from './ScoreRail';

import useGameStore from '@/lib/game/store';
import { playerIndexForTurn, roundForTurn } from '@/lib/game/turns';

export default function GameBoard() {
  const players = useGameStore((s) => s.players);
  const turnIndex = useGameStore((s) => s.turnIndex);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const matchLocations = useGameStore((s) => s.matchLocations);
  const phase = useGameStore((s) => s.phase);
  const turnResult = useGameStore((s) => s.turnResult);
  const backToSetup = useGameStore((s) => s.backToSetup);

  const location = matchLocations[turnIndex];
  const player = players[playerIndexForTurn(turnIndex, players.length)];

  // A persisted match whose locations are gone can only be abandoned cleanly.
  if (!location || !player) {
    return (
      <main className="centered">
        <div className="panel">
          <h1>Match interrupted</h1>
          <p className="subtitle">This match&apos;s locations are no longer available.</p>
          <button type="button" className="primary-button" onClick={backToSetup}>
            Back to setup
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="board">
      <header className="board-header">
        <span className="round-counter">
          Round {roundForTurn(turnIndex, players.length)} of {totalRounds}
        </span>
        <span className="turn-indicator">
          <strong>{player.name}</strong>
          {"'"}s turn
        </span>
        <button type="button" className="text-button" onClick={backToSetup}>
          End match
        </button>
      </header>

      <ScoreRail />

      <PanoramaViewer imageId={location.id} initialYaw={location.initialYaw} />

      <AttributionBar location={location} />

      <GuessTray />

      {phase === 'reveal' && turnResult && <RevealOverlay result={turnResult} />}
    </main>
  );
}
