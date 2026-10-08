import { describe, expect, it } from "vitest";
import { createRng, nextFloat, nextInt, nextU32, pick } from "@sim/rng";

describe("rng", () => {
  it("produces the same sequence for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 1000; i++) expect(nextU32(a)).toBe(nextU32(b));
  });

  it("produces different sequences for different seeds", () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => nextU32(a));
    const seqB = Array.from({ length: 10 }, () => nextU32(b));
    expect(seqA).not.toEqual(seqB);
  });

  it("survives a JSON round-trip mid-sequence (save/load)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 50; i++) nextU32(rng);
    const restored = JSON.parse(JSON.stringify(rng)) as typeof rng;
    for (let i = 0; i < 100; i++) expect(nextU32(restored)).toBe(nextU32(rng));
  });

  it("keeps floats in [0, 1) and roughly uniform", () => {
    const rng = createRng(123);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const f = nextFloat(rng);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      buckets[Math.floor(f * 10)]!++;
    }
    for (const count of buckets) expect(Math.abs(count - n / 10)).toBeLessThan(n * 0.01);
  });

  it("nextInt covers the inclusive range and nothing outside it", () => {
    const rng = createRng(9);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = nextInt(rng, 3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7]);
  });

  it("pick throws on an empty array", () => {
    expect(() => pick(createRng(1), [])).toThrow();
  });
});
