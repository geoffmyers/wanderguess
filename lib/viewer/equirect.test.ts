import { describe, expect, it } from 'vitest';

import gameConfig from '@/config/game-config.json';
import { autoPanStep } from './equirect';

/**
 * Auto-pan's timing maths.
 *
 * Tested here rather than by screenshot on purpose: Chromium's headless
 * virtual-time mode advances timers without producing matching animation
 * frames, so a rendered comparison shows a sweep that has barely moved whether
 * the maths is right or wrong. That test was written, run, and deleted - it
 * could not fail.
 *
 * The sign convention it depends on (a positive speed turns the view right,
 * which the shader reaches by DECREASING yaw) was verified against rendered
 * pixels for `initialBearingDeg`, which is the same relationship.
 */

const DEG = Math.PI / 180;
const TURN = Math.PI * 2;

/** Signed difference in radians, so a wrap does not read as a huge jump. */
function turnedBy(from: number, to: number): number {
  return (((from - to) % TURN) + TURN + Math.PI) % TURN - Math.PI;
}

describe('autoPanStep', () => {
  it('turns the view to the right, which means decreasing yaw', () => {
    // Not cosmetic: a sign flip here sweeps away from whatever the round opened
    // facing, and still renders a perfectly ordinary street.
    expect(autoPanStep(0, 6, 16)).toBeGreaterThan(Math.PI); // wrapped just below a full turn
    expect(turnedBy(0, autoPanStep(0, 6, 16))).toBeGreaterThan(0);
  });

  it('moves by the configured degrees per second, not per frame', () => {
    // Ten 100 ms steps and one second must land in the same place, or the sweep
    // speed would depend on the refresh rate.
    let stepped = 1;
    for (let i = 0; i < 10; i++) stepped = autoPanStep(stepped, 6, 100);
    expect(turnedBy(1, stepped)).toBeCloseTo(6 * DEG, 6);
  });

  it('takes a minute for a full revolution at the configured speed', () => {
    const speed = gameConfig.viewer.autoPanDegreesPerSecond;
    expect(360 / speed).toBeLessThanOrEqual(90);
    expect(360 / speed).toBeGreaterThanOrEqual(30);
  });

  it('clamps a long gap instead of spinning through several revolutions', () => {
    // A backgrounded tab returns with a gap of seconds or minutes.
    const afterHugeGap = autoPanStep(1, 6, 5 * 60 * 1000);
    const afterClamp = autoPanStep(1, 6, 100);
    expect(afterHugeGap).toBeCloseTo(afterClamp, 10);
  });

  it('ignores a negative elapsed time rather than panning backwards', () => {
    expect(autoPanStep(1, 6, -500)).toBeCloseTo(1, 10);
  });

  it('wraps into one revolution so a long session keeps its precision', () => {
    let yaw = 0;
    // An hour at 60fps, stepped coarsely.
    for (let i = 0; i < 36_000; i++) yaw = autoPanStep(yaw, 6, 100);
    expect(yaw).toBeGreaterThanOrEqual(0);
    expect(yaw).toBeLessThan(TURN);
  });

  it('is configured to start on its own, which is what makes the escape hatch load-bearing', () => {
    // The sweep starting unasked is only reasonable because any interaction
    // stops it. `yieldToUser` is wired to pointerdown AND wheel; if the default
    // is ever flipped back off, this test should be revisited rather than
    // deleted - it is here to keep the two decisions tied together.
    expect(gameConfig.viewer.autoPanOnByDefault).toBe(true);
    expect(gameConfig.viewer.respectsReducedMotion).toBe(true);
  });

  it('completes a 360 loop and returns to where it started', () => {
    const speed = gameConfig.viewer.autoPanDegreesPerSecond;
    let yaw = 0;
    // Exactly one revolution's worth of 100 ms steps.
    const steps = Math.round((360 / speed) * 10);
    for (let i = 0; i < steps; i++) yaw = autoPanStep(yaw, speed, 100);
    expect(Math.abs(turnedBy(0, yaw))).toBeLessThan(0.001);
  });
});
