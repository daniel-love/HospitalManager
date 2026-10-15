/**
 * Shared mobile equipment (GAME_DESIGN §4.3): wheeled kit such as the 12-lead
 * ECG isn't tied to the room it's kept in. Staff fetch it to any room within
 * SHARED_KIT_RANGE tiles of walking from where it's kept, so those rooms gain
 * its capabilities. Which rooms each item reaches depends only on the layout,
 * so it's worked out by detectRooms() and kept until the next change.
 */
import { equipmentById } from "@data/catalogue";
import { SHARED_KIT_RANGE } from "@data/equipment";
import type { Room, SimState } from "../state";
import { inBounds, tileIndex } from "./grid";
import { objectRect } from "./objects";
import { isWalkable } from "./pathfinding";
import { inService } from "./service";

const reachCache = new WeakMap<SimState, Map<number, Set<number>>>();

export function isMobile(defId: string): boolean {
  return equipmentById.get(defId)?.mobile ?? false;
}

/**
 * Adds each piece of shared kit's capabilities to the rooms it reaches.
 * Called by detectRooms() once the rooms are found.
 */
export function shareKit(state: SimState, rooms: Room[]): void {
  const reach = new Map<number, Set<number>>();
  for (const obj of Object.values(state.objects)) {
    const def = equipmentById.get(obj.defId);
    if (!def?.mobile) continue;
    // Broken or without power, it can't be fetched to anyone.
    if (!inService(state, obj.id)) continue;
    const ids = roomsWithin(state, obj.id, SHARED_KIT_RANGE);
    reach.set(obj.id, ids);
    for (const id of ids) {
      const room = rooms[id - 1];
      if (!room) continue;
      for (const c of def.capabilities)
        if (!room.capabilities.includes(c)) room.capabilities.push(c);
    }
  }
  reachCache.set(state, reach);
}

/** Every piece of shared kit placed. */
export function sharedKitIds(state: SimState): number[] {
  return [...(reachCache.get(state)?.keys() ?? [])];
}

/** Shared kit away from where it's kept: kit id → who has it. */
export function kitsOut(state: SimState): Map<number, number> {
  const out = new Map<number, number>();
  for (const job of Object.values(state.jobs)) {
    if (job.kit && job.kit.at !== "store" && job.staffId !== null) {
      out.set(job.kit.objectId, job.staffId);
    }
  }
  return out;
}

/** Rooms (ids) a piece of shared kit can be wheeled to. */
export function kitReach(state: SimState, kitId: number): Set<number> {
  return reachCache.get(state)?.get(kitId) ?? new Set();
}

/**
 * Rooms with a tile within `range` steps of walking from the item, counting
 * a diagonal step as one (as path lengths do) but never cutting a corner.
 */
function roomsWithin(state: SimState, objectId: number, range: number): Set<number> {
  const obj = state.objects[objectId]!;
  const grid = state.floors[obj.floor]!;
  const r = objectRect(obj);
  const rooms = new Set<number>();
  const own = grid.roomId[tileIndex(grid, r.x, r.y)]!;
  if (own !== 0) rooms.add(own);

  const dist = new Map<number, number>();
  let frontier: number[] = [];
  for (let y = r.y - 1; y <= r.y + r.h; y++) {
    for (let x = r.x - 1; x <= r.x + r.w; x++) {
      if (!inBounds(grid, x, y)) continue;
      const i = tileIndex(grid, x, y);
      if (dist.has(i) || !isWalkable(grid, i)) continue;
      // Only tiles beside the item, not past a wall corner.
      const ox = Math.min(Math.max(x, r.x), r.x + r.w - 1);
      const oy = Math.min(Math.max(y, r.y), r.y + r.h - 1);
      if (x !== ox && y !== oy) continue;
      dist.set(i, 1);
      frontier.push(i);
    }
  }
  for (let d = 1; d <= range && frontier.length > 0; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const id = grid.roomId[i]!;
      if (id !== 0) rooms.add(id);
      if (d === range) continue;
      const x = i % grid.width;
      const y = (i - x) / grid.width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(grid, nx, ny)) continue;
          const j = tileIndex(grid, nx, ny);
          if (dist.has(j) || !isWalkable(grid, j)) continue;
          if (dx !== 0 && dy !== 0) {
            const a = tileIndex(grid, x + dx, y);
            const b = tileIndex(grid, x, y + dy);
            if (!isWalkable(grid, a) || !isWalkable(grid, b)) continue;
          }
          dist.set(j, d + 1);
          next.push(j);
        }
      }
    }
    frontier = next;
  }
  return rooms;
}
