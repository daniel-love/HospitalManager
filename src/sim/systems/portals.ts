/**
 * Getting between floors (ROADMAP M7 step 2). Someone heading for another
 * floor walks to the stairs or a lift chosen for them (systems/movement.ts),
 * then:
 *
 *   stairs: climbs (or goes down), taking as long as walking
 *     STAIRS_TILES_PER_FLOOR tiles a floor, and steps off on the new floor;
 *   lift:   waits at the doors until the car comes and has room (a bed and
 *     its porter take most of it), rides, and gets out on the new floor.
 *
 * Each lift has one car. With nobody in it, it goes to the nearest floor
 * where someone's waiting; with riders, to the nearest floor one of them
 * wants. A lift that breaks down or loses power stops: those waiting choose
 * again, and anyone inside waits for it to be fixed.
 *
 * Off the stairs or out of the lift, they plan the rest of the way afresh.
 */
import { LIFT, STAIRS_TILES_PER_FLOOR } from "@data/structures";
import { PATIENT_SPEED, STAFF_SPEED } from "@data/patients";
import type { AgentBase } from "../agents";
import type { LiftCar, SimState } from "../state";
import { portalByKey, portals, portalStop, portalWorking, type Portal } from "../world/portals";

/** Everyone who walks about the site. */
export function allAgents(state: SimState): AgentBase[] {
  return [
    ...Object.values(state.patients),
    ...Object.values(state.staff),
    ...Object.values(state.outpatients),
    ...Object.values(state.visitors),
    ...Object.values(state.tours),
    ...Object.values(state.collections).map((c) => c.crew),
  ];
}

/** How many are waiting for a lift on a floor. */
export function waitingFor(state: SimState, portalKey: string, floor: number): number {
  let n = 0;
  for (const a of allAgents(state)) {
    const t = a.transit;
    if (t && t.portal === portalKey && t.phase === "waiting" && t.from === floor) n++;
  }
  return n;
}

export function updatePortals(state: SimState): void {
  const travelling = allAgents(state).filter((a) => a.transit);
  for (const a of travelling) {
    const t = a.transit!;
    const portal = portalByKey(state, t.portal);
    if (!portal) {
      // Taken out from under them: off where they are, to choose again.
      if (t.phase === "riding" || t.phase === "climbing") stepOff(a, a.floor, a);
      else drop(a);
      continue;
    }
    if (t.phase === "walking" && a.path.length === 0) {
      const stop = portalStop(portal, t.from);
      if (Math.round(a.x) !== stop.x || Math.round(a.y) !== stop.y) {
        drop(a); // Didn't get there: choose again.
        continue;
      }
      if (portal.kind === "stairs") {
        const speed = "role" in a ? STAFF_SPEED : PATIENT_SPEED;
        const floors = Math.abs(t.to - t.from);
        t.phase = "climbing";
        t.at = state.tick;
        t.until = state.tick + Math.ceil((STAIRS_TILES_PER_FLOOR * floors) / speed);
      } else {
        t.phase = "waiting";
        t.at = state.tick;
      }
    } else if (t.phase === "climbing" && state.tick >= t.until) {
      stepOff(a, t.to, portalStop(portal, t.to));
    } else if (t.phase === "waiting" && !portalWorking(state, portal)) {
      drop(a); // Out of service: choose again (the stairs, or another lift).
    }
  }
  for (const portal of portals(state)) {
    if (portal.kind === "lift") runCar(state, portal, travelling);
  }
}

/** Off the stairs or out of the lift onto `floor`, to plan the rest of the way. */
function stepOff(a: AgentBase, floor: number, at: { x: number; y: number }): void {
  a.floor = floor;
  a.x = a.prevX = at.x;
  a.y = a.prevY = at.y;
  a.path = [];
  a.dest = null;
  a.transit = null;
}

/** Out of a lift queue (or not at the stop after all): they'll choose a way again. */
function drop(a: AgentBase): void {
  a.path = [];
  a.dest = null;
  a.transit = null;
}

function runCar(state: SimState, portal: Portal, travelling: AgentBase[]): void {
  const car: LiftCar = (state.lifts[portal.key] ??= {
    floor: portal.floors[0]!,
    phase: "idle",
    target: portal.floors[0]!,
    until: 0,
    riders: [],
  });
  if (!portalWorking(state, portal)) return; // Stopped where it is until it's fixed.
  // Still on their way (some stepped off or chose again earlier this tick).
  const stillGoing = travelling.filter((a) => a.transit);
  const byId = new Map(stillGoing.map((a) => [a.id, a]));
  const riders = car.riders.map((id) => byId.get(id)).filter((a): a is AgentBase => !!a);
  car.riders = riders.map((a) => a.id);
  const waiting = stillGoing.filter(
    (a) => a.transit!.portal === portal.key && a.transit!.phase === "waiting",
  );

  if (car.phase === "moving") {
    if (state.tick < car.until) return;
    car.floor = car.target;
    openDoors(state, portal, car, riders, waiting);
    return;
  }
  if (car.phase === "doors" && state.tick < car.until) return;

  // Doors shut (or idle): where next?
  const floors =
    riders.length > 0 ? riders.map((a) => a.transit!.to) : waiting.map((a) => a.transit!.from);
  if (floors.length === 0) {
    car.phase = "idle";
    return;
  }
  const next = floors.reduce((best, f) =>
    Math.abs(f - car.floor) < Math.abs(best - car.floor) ||
    (Math.abs(f - car.floor) === Math.abs(best - car.floor) && f < best)
      ? f
      : best,
  );
  if (next === car.floor) {
    // Someone's here: open up (if anyone can get on).
    if (car.phase === "doors" && !roomFor(car, riders, waiting)) {
      car.phase = "idle";
      return;
    }
    openDoors(state, portal, car, riders, waiting);
    return;
  }
  car.phase = "moving";
  car.target = next;
  car.until = state.tick + Math.abs(next - car.floor) * LIFT.ticksPerFloor;
}

/** Whether anyone waiting on the car's floor fits in it. */
function roomFor(car: LiftCar, riders: AgentBase[], waiting: AgentBase[]): boolean {
  const used = riders.reduce((n, a) => n + a.transit!.load, 0);
  return waiting.some(
    (a) => a.transit!.from === car.floor && used + a.transit!.load <= LIFT.capacity,
  );
}

/** At a floor: those for it get out, and those waiting get in, first come first, while there's room. */
function openDoors(
  state: SimState,
  portal: Portal,
  car: LiftCar,
  riders: AgentBase[],
  waiting: AgentBase[],
): void {
  car.phase = "doors";
  car.until = state.tick + LIFT.doorTicks;
  const stop = portalStop(portal, car.floor);
  for (const a of riders) {
    if (a.transit!.to === car.floor) stepOff(a, car.floor, stop);
  }
  const staying = riders.filter((a) => a.transit);
  let used = staying.reduce((n, a) => n + a.transit!.load, 0);
  const here = waiting
    .filter((a) => a.transit!.from === car.floor)
    .sort((a, b) => a.transit!.at - b.transit!.at || a.id - b.id);
  for (const a of here) {
    if (used + a.transit!.load > LIFT.capacity) continue;
    used += a.transit!.load;
    a.transit!.phase = "riding";
    staying.push(a);
  }
  car.riders = staying.map((a) => a.id);
}
