import { GAME } from './constants';
import type { Player } from '@/lib/types/game';

/**
 * Turn order is derived from a single monotonic `turnIndex` rather than tracked
 * as a separate player pointer plus round counter. Every player takes exactly
 * one turn per round, so position falls out of arithmetic and the two counters
 * can never drift apart.
 *
 * This is what replaces the photo game's two-player `% 2` rotation and its
 * pendingWinner / isTieBreaker pair: with equal turns guaranteed by
 * construction, no tie-breaker special case is needed at all.
 */

export function playerIndexForTurn(turnIndex: number, playerCount: number): number {
  if (playerCount < 1) throw new Error('playerCount must be at least 1');
  return turnIndex % playerCount;
}

export function roundForTurn(turnIndex: number, playerCount: number): number {
  if (playerCount < 1) throw new Error('playerCount must be at least 1');
  return Math.floor(turnIndex / playerCount) + 1;
}

export function totalTurns(playerCount: number, totalRounds: number): number {
  return playerCount * totalRounds;
}

export function isMatchOver(
  turnIndex: number,
  playerCount: number,
  totalRounds: number
): boolean {
  return turnIndex >= totalTurns(playerCount, totalRounds);
}

/** Players sorted by score, highest first. Equal scores keep their entry order. */
export function rankPlayers(players: Player[]): Player[] {
  return [...players].sort((a, b) => b.score - a.score);
}

/**
 * Every player tied at the top score. Returns one player for an outright win,
 * several for a shared win, and an empty array for an empty roster.
 */
export function determineWinners(players: Player[]): Player[] {
  if (players.length === 0) return [];
  const best = Math.max(...players.map((p) => p.score));
  return players.filter((p) => p.score === best);
}

/**
 * How many rounds the pool can support without repeating a location, given that
 * each player needs a distinct location every round.
 */
export function maxRoundsForPool(poolSize: number, playerCount: number): number {
  if (playerCount < 1) return 0;
  return Math.floor(poolSize / playerCount);
}

/**
 * The fewest locations a startable match needs: one per player for the shortest
 * offered match.
 *
 * This is the threshold every "is this playable?" check uses, so the pickers,
 * the round chips and the shortfall message all agree. Testing against one
 * round instead - which the scope picker used to do - offers a scope that then
 * has no round count to select, which reads as the Start button being broken.
 */
export function minimumMatchLocations(playerCount: number): number {
  return playerCount * Math.min(...(GAME.roundOptions as number[]));
}
