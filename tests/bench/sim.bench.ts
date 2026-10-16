/**
 * Simulation benchmark (not part of `npm test`; run `npm run bench`).
 * Warms the stress map up (game/maps/stressHospital.ts) until its wards
 * fill, then times a simulated day tick by tick: the mean and worst tick,
 * each system's share, and how many agents were on the map. ROADMAP M7
 * step 1 has the budget: at 16× the game runs 160 ticks a second inside a
 * 10 ms-per-frame sim budget, so about 3.75 ms a tick at most.
 */
import { it } from "vitest";
import { onSite } from "@sim/agents";
import { profiledTick, tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { clockFromTick, TICKS_PER_DAY } from "@sim/time";

const clock = (t: number) => {
  const c = clockFromTick(t);
  return `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
};
import { buildStressHospital, STRESS_CATCHMENT, STRESS_COPIES } from "@game/maps/stressHospital";

const WARM_UP_DAYS = Number(process.env.WARM_UP_DAYS ?? 3);
const COPIES = Number(process.env.COPIES ?? STRESS_COPIES);
const CATCHMENT = Number(process.env.CATCHMENT ?? STRESS_CATCHMENT);

function agents(state: SimState) {
  const n = (r: object) => Object.keys(r).length;
  const staffOnSite = Object.values(state.staff).filter(onSite).length;
  return {
    patients: n(state.patients),
    staff: n(state.staff),
    staffOnSite,
    outpatients: n(state.outpatients),
    visitors: n(state.visitors),
    total:
      n(state.patients) + staffOnSite + n(state.outpatients) + n(state.visitors) + n(state.tours),
  };
}

it("times a day on the stress map", () => {
  const state = buildStressHospital(1, COPIES, CATCHMENT);
  const t0 = performance.now();
  for (let i = 0; i < WARM_UP_DAYS * TICKS_PER_DAY; i++) tick(state);
  const warm = performance.now() - t0;

  const ms: Record<string, number> = {};
  const ticks: number[] = [];
  let peak = 0;
  let sum = 0;
  // The slowest ticks, with what took the time in each.
  const slow: { ms: number; tick: number; top: string }[] = [];
  for (let i = 0; i < TICKS_PER_DAY; i++) {
    const one: Record<string, number> = {};
    const s = performance.now();
    profiledTick(state, one);
    const took = performance.now() - s;
    ticks.push(took);
    for (const [k, v] of Object.entries(one)) ms[k] = (ms[k] ?? 0) + v;
    if (took > 5) {
      const top = Object.entries(one)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k} ${v.toFixed(1)}`)
        .join(", ");
      slow.push({ ms: took, tick: state.tick, top });
    }
    if (i % 100 === 0) {
      const a = agents(state).total;
      peak = Math.max(peak, a);
      sum += a;
    }
  }
  ticks.sort((a, b) => a - b);
  const total = ticks.reduce((a, b) => a + b, 0);
  const pct = (q: number) => ticks[Math.floor(q * (ticks.length - 1))]!.toFixed(3);
  const lines = [
    `copies ${COPIES}, catchment ${CATCHMENT} each, warm-up ${WARM_UP_DAYS} days in ${(warm / 1000).toFixed(1)} s`,
    `agents now ${JSON.stringify(agents(state))}, peak ${peak}, mean ${Math.round(sum / (TICKS_PER_DAY / 100))}`,
    `tick ms: mean ${(total / ticks.length).toFixed(3)}, p50 ${pct(0.5)}, p99 ${pct(0.99)}, p99.9 ${pct(0.999)}, worst ${pct(1)}`,
    "by system (ms per tick, share):",
    ...Object.entries(ms)
      .sort((a, b) => b[1] - a[1])
      .filter(([, v]) => v / total > 0.005)
      .map(
        ([k, v]) =>
          `  ${k.padEnd(22)} ${(v / ticks.length).toFixed(3)}  ${((100 * v) / total).toFixed(1)}%`,
      ),
  ];
  slow.sort((a, b) => b.ms - a.ms);
  lines.push(
    `ticks over 5 ms: ${slow.length} (${((100 * slow.length) / ticks.length).toFixed(2)}%); slowest:`,
  );
  for (const t of slow.slice(0, 12)) {
    lines.push(`  ${t.ms.toFixed(1)} ms at ${clock(t.tick)}: ${t.top}`);
  }
  console.log(lines.join("\n"));
}, 3_600_000);
