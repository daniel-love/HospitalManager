/**
 * Messages for the notifications feed (ARCHITECTURE §2: events out). The sim
 * only ever appends to state.events; the game drains them each frame.
 */
import type { Point, SimEvent } from "./agents";
import type { SimState } from "./state";

/** More than this many undrained events (e.g. a headless run) drops the oldest. */
const MAX_PENDING = 200;

export function emit(
  state: SimState,
  text: string,
  severity: SimEvent["severity"] = "info",
  at?: Point,
): void {
  state.events.push({ tick: state.tick, text, severity, ...(at ? { at: { ...at } } : {}) });
  if (state.events.length > MAX_PENDING) state.events.splice(0, state.events.length - MAX_PENDING);
}

/**
 * Raises a warning unless the same kind was raised within `cooldown` ticks,
 * so an ongoing problem nags occasionally rather than every tick.
 */
export function warn(
  state: SimState,
  key: string,
  cooldown: number,
  text: string,
  severity: SimEvent["severity"] = "warn",
  at?: Point,
): void {
  const last = state.alerts[key];
  if (last !== undefined && state.tick - last < cooldown) return;
  state.alerts[key] = state.tick;
  emit(state, text, severity, at);
}
