import { describe, expect, it } from "vitest";
import { FixedStepLoop } from "@game/loop";

function makeLoop(opts: Partial<ConstructorParameters<typeof FixedStepLoop>[1]> = {}) {
  let ticks = 0;
  const loop = new FixedStepLoop(() => ticks++, {
    ticksPerSecond: 50,
    now: () => 0, // sim work costs nothing unless a test says otherwise
    ...opts,
  });
  return { loop, ticks: () => ticks };
}

/** Simulates `seconds` of real time at 60 fps. */
function runFrames(loop: FixedStepLoop, seconds: number) {
  for (let i = 0; i < seconds * 60; i++) loop.advance(1000 / 60);
}

describe("FixedStepLoop", () => {
  it("runs ticksPerSecond ticks per real second at 1×", () => {
    const { loop, ticks } = makeLoop();
    runFrames(loop, 2);
    expect(ticks()).toBe(100);
  });

  it.each([2, 4, 8] as const)("runs %i× as many ticks at %i× speed", (speed) => {
    const { loop, ticks } = makeLoop();
    loop.setSpeed(speed);
    runFrames(loop, 1);
    expect(ticks()).toBe(50 * speed);
  });

  it("runs no ticks while paused, and resumes cleanly", () => {
    const { loop, ticks } = makeLoop();
    loop.setSpeed(0);
    runFrames(loop, 1);
    expect(ticks()).toBe(0);
    loop.setSpeed(1);
    runFrames(loop, 1);
    expect(ticks()).toBe(50);
  });

  it("stepOnce advances one tick even while paused", () => {
    const { loop, ticks } = makeLoop();
    loop.setSpeed(0);
    loop.stepOnce();
    expect(ticks()).toBe(1);
  });

  it("is independent of frame rate", () => {
    const a = makeLoop();
    const b = makeLoop();
    for (let i = 0; i < 30; i++) a.loop.advance(1000 / 30);
    for (let i = 0; i < 144; i++) b.loop.advance(1000 / 144);
    expect(a.ticks()).toBe(50);
    expect(Math.abs(b.ticks() - 50)).toBeLessThanOrEqual(1);
  });

  it("exposes the leftover fraction as alpha", () => {
    const { loop } = makeLoop();
    loop.advance(30); // 1.5 ticks at 20 ms per tick
    expect(loop.alpha).toBeCloseTo(0.5);
  });

  it("clamps huge frame gaps instead of running thousands of ticks", () => {
    const { loop, ticks } = makeLoop({ maxFrameMs: 250 });
    loop.advance(60_000); // tab was hidden for a minute
    expect(ticks()).toBe(12); // 250 ms / 20 ms
  });

  it("drops the backlog when the per-frame tick cap is hit", () => {
    const { loop, ticks } = makeLoop({ maxTicksPerFrame: 5 });
    loop.setSpeed(8);
    const stats = loop.advance(100); // wants 40 ticks
    expect(ticks()).toBe(5);
    expect(stats.ticksDropped).toBe(35);
    expect(loop.alpha).toBeLessThan(1);
  });

  it("stops early when the time budget is exceeded", () => {
    let clock = 0;
    let ticks = 0;
    const loop = new FixedStepLoop(
      () => {
        ticks++;
        clock += 3; // each tick costs 3 ms
      },
      { ticksPerSecond: 50, budgetMs: 10, now: () => clock },
    );
    loop.setSpeed(8);
    const stats = loop.advance(100);
    expect(ticks).toBe(4); // 0, 3, 6, 9 ms all under budget; 12 ms is over
    expect(stats.simMs).toBe(12);
  });
});
