/**
 * Advances the simulation by one fixed tick. Systems will run here in the
 * order given in ARCHITECTURE.md §4.2 as they are added.
 */
import type { SimState } from "./state";

export function tick(state: SimState): void {
  state.tick++;
}
