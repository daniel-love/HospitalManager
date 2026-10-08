/**
 * Seeded pseudo-random number generator (sfc32).
 *
 * The generator's state is a plain array stored inside SimState, so it is saved
 * with the game. Same seed + same commands = same outcome, which lets us replay
 * bugs from a save file. Never use Math.random() in simulation code.
 */

/** Four 32-bit words. Mutated in place by every draw. */
export type RngState = [number, number, number, number];

/** Expands a single 32-bit seed into well-mixed starting words (splitmix32). */
export function createRng(seed: number): RngState {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  const rng: RngState = [next(), next(), next(), next()];
  // Discard the first few outputs; sfc32 is weak immediately after seeding.
  for (let i = 0; i < 12; i++) nextU32(rng);
  return rng;
}

/** Uniform integer in [0, 2^32). */
export function nextU32(rng: RngState): number {
  let [a, b, c, d] = rng;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  rng[0] = a;
  rng[1] = b;
  rng[2] = c;
  rng[3] = d;
  return t >>> 0;
}

/** Uniform float in [0, 1). */
export function nextFloat(rng: RngState): number {
  return nextU32(rng) / 4294967296;
}

/** Uniform integer in [min, max] (inclusive). */
export function nextInt(rng: RngState, min: number, max: number): number {
  return min + Math.floor(nextFloat(rng) * (max - min + 1));
}

/** True with probability p. */
export function chance(rng: RngState, p: number): boolean {
  return nextFloat(rng) < p;
}

/** Uniformly chosen element. Throws on an empty array. */
export function pick<T>(rng: RngState, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick() from empty array");
  return items[nextInt(rng, 0, items.length - 1)] as T;
}
