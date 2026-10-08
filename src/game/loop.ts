/**
 * Fixed-timestep game loop.
 *
 * The renderer runs at whatever frame rate the browser gives us, but the sim
 * must always advance in identical, fixed-size ticks so it stays deterministic.
 * Each frame we add the real elapsed time (scaled by game speed) to an
 * "accumulator" and run as many whole ticks as fit. The leftover fraction is
 * exposed as `alpha` so the renderer can interpolate agents between ticks.
 *
 * If the sim can't keep up (too many ticks per frame, or it blows the frame's
 * time budget), we drop the backlog instead of trying to catch up forever:
 * the game slows down rather than freezing.
 */

export const SPEEDS = [0, 1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];

export interface LoopOptions {
  /** Ticks per real second at 1× speed. */
  ticksPerSecond: number;
  /** Hard cap on ticks run in a single frame. */
  maxTicksPerFrame?: number;
  /** Stop running ticks this frame once this many ms of sim work have been spent. */
  budgetMs?: number;
  /** Longest real frame gap we honour, e.g. after the tab was hidden. */
  maxFrameMs?: number;
  /** Clock used to measure sim cost; injectable for tests. */
  now?: () => number;
}

export interface FrameStats {
  ticksRun: number;
  /** Real ms spent inside step() this frame. */
  simMs: number;
  /** Ticks discarded this frame because the sim couldn't keep up. */
  ticksDropped: number;
}

export class FixedStepLoop {
  speed: Speed = 1;
  readonly tickMs: number;
  private accumulatorMs = 0;
  private readonly maxTicksPerFrame: number;
  private readonly budgetMs: number;
  private readonly maxFrameMs: number;
  private readonly now: () => number;

  constructor(
    private readonly step: () => void,
    opts: LoopOptions,
  ) {
    this.tickMs = 1000 / opts.ticksPerSecond;
    this.maxTicksPerFrame = opts.maxTicksPerFrame ?? 64;
    this.budgetMs = opts.budgetMs ?? 10;
    this.maxFrameMs = opts.maxFrameMs ?? 250;
    this.now = opts.now ?? (() => performance.now());
  }

  get paused(): boolean {
    return this.speed === 0;
  }

  /** Fraction (0–1) of the way to the next tick, for render interpolation. */
  get alpha(): number {
    return this.accumulatorMs / this.tickMs;
  }

  setSpeed(speed: Speed): void {
    this.speed = speed;
    if (speed === 0) this.accumulatorMs = 0;
  }

  /** Runs exactly one tick regardless of speed (debug "step" while paused). */
  stepOnce(): void {
    this.step();
  }

  /** Feed the real time since the last frame. Runs zero or more ticks. */
  advance(realDtMs: number): FrameStats {
    if (this.speed === 0) return { ticksRun: 0, simMs: 0, ticksDropped: 0 };

    const dt = Math.min(Math.max(realDtMs, 0), this.maxFrameMs);
    this.accumulatorMs += dt * this.speed;

    const start = this.now();
    let ticksRun = 0;
    while (this.accumulatorMs >= this.tickMs) {
      if (ticksRun >= this.maxTicksPerFrame || this.now() - start >= this.budgetMs) break;
      this.step();
      this.accumulatorMs -= this.tickMs;
      ticksRun++;
    }
    const simMs = this.now() - start;

    let ticksDropped = 0;
    if (this.accumulatorMs >= this.tickMs) {
      ticksDropped = Math.floor(this.accumulatorMs / this.tickMs);
      this.accumulatorMs -= ticksDropped * this.tickMs;
    }
    return { ticksRun, simMs, ticksDropped };
  }
}
