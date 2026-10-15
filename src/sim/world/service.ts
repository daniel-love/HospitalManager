/**
 * Whether a piece of equipment is in service: not broken down, and powered.
 * In a power cut, powered items work only if the standby generators cover
 * them: rooms on the essential supply first, in POWER.essential's order,
 * then the rest while capacity lasts. Worked out by detectRooms() (which
 * the maintenance system reruns when something breaks, is repaired, or the
 * power goes or comes back), so rooms lose what's out of service.
 */
import { equipmentById } from "@data/catalogue";
import { POWER } from "@data/maintenance";
import { pressureEventById } from "@data/pressure";
import type { Room, SimState } from "../state";

/** Powered items without power now (in a power cut, beyond the generators' cover). */
const unpowered = new WeakMap<SimState, Set<number>>();

export function isBroken(state: SimState, objectId: number): boolean {
  return state.maintenance[objectId]?.broken != null;
}

export function isPowered(state: SimState, objectId: number): boolean {
  return !unpowered.get(state)?.has(objectId);
}

export function inService(state: SimState, objectId: number): boolean {
  return !isBroken(state, objectId) && isPowered(state, objectId);
}

/** A power cut under way. */
export function powerCut(state: SimState): boolean {
  return state.pressure.active.some(
    (e) => pressureEventById.get(e.defId)!.powerCut && state.tick >= e.start && state.tick < e.end,
  );
}

/** Working standby generators in Plant Rooms, and how many powered items they can carry. */
export function generatorCapacity(state: SimState, rooms: Room[]): number {
  let n = 0;
  for (const r of rooms) {
    if (r.typeId !== "plant_room") continue;
    for (const id of r.objectIds) {
      if (state.objects[id]?.defId === "standby_generator" && !isBroken(state, id)) n++;
    }
  }
  return n * POWER.itemsPerGenerator;
}

/** Where a room comes in the generators' order: essential rooms by type, then the rest. */
function priority(room: Room): number {
  if (!room.essential) return 1000;
  const i = POWER.essential.indexOf(room.typeId);
  return i < 0 ? POWER.essential.length : i;
}

/**
 * Works out which powered items are without power: none unless there's a
 * power cut; then everything beyond the generators' capacity, essential
 * rooms first. Items outside rooms come last. Called by detectRooms().
 */
export function computeSupply(
  state: SimState,
  rooms: Room[],
  objectRoom: Record<number, number>,
): void {
  const off = new Set<number>();
  unpowered.set(state, off);
  if (!powerCut(state)) return;
  let capacity = generatorCapacity(state, rooms);
  const powered = Object.values(state.objects)
    .filter((o) => equipmentById.get(o.defId)?.power)
    .map((o) => {
      const id = objectRoom[o.id];
      return { o, rank: id === undefined ? 2000 : priority(rooms[id - 1]!) };
    })
    .sort((a, b) => a.rank - b.rank || a.o.id - b.o.id);
  for (const { o } of powered) {
    if (capacity > 0) capacity--;
    else off.add(o.id);
  }
}
