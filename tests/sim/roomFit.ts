/**
 * Brute-force check that a room type can actually be made valid at a given
 * size: builds the room in isolation, then searches for a placement of its
 * required equipment that satisfies every placement and room rule.
 *
 * Layout used: walls on three sides, the fourth (bottom) side open onto a
 * 2-tile corridor for open rooms, or walled with a door in the middle for
 * enclosed rooms. Each piece of equipment is the smallest option allowed.
 */
import { equipmentById, roomById } from "@data/catalogue";
import { applyCommand, planCommand } from "@sim/commands";
import { createSimState, type Rotation, type SimState } from "@sim/state";
import { WallType } from "@sim/world/grid";
import { roomAt } from "@sim/world/rooms";

export interface FitResult {
  ok: boolean;
  /** Placements found, as "defId@x,y r" strings. */
  layout: string[];
  /** Search gave up (counts as not fitting). */
  exhausted: boolean;
  nodes: number;
  failing: string[];
}

function shapeKeyOf(defId: string): string {
  const e = equipmentById.get(defId)!;
  return JSON.stringify([e.footprint, e.access, e.mount]);
}

/** The items a room type needs, cheapest-footprint option for each. */
export function requiredItems(roomType: string): string[] {
  const def = roomById.get(roomType)!;
  const area = (id: string) => {
    const e = equipmentById.get(id)!;
    return e.footprint[0] * e.footprint[1];
  };
  const items: string[] = [];
  for (const req of def.required) {
    const best = [...req.anyOf].sort((a, b) => area(a) - area(b))[0]!;
    for (let i = 0; i < req.count; i++) items.push(best);
  }
  if (def.minSeats) {
    // Chairs are the most flexible seating.
    for (let i = 0; i < def.minSeats; i++) items.push("waiting_chair");
  }
  // Biggest first (hardest to place), then grouped by shape for symmetry breaking.
  return items.sort((a, b) => area(b) - area(a) || shapeKeyOf(a).localeCompare(shapeKeyOf(b)));
}

/**
 * `walled`: wall all four sides even for open rooms, so equipment can't rely
 * on facing out into the corridor.
 */
export function buildRoom(roomType: string, w: number, h: number, walled = false): SimState {
  const def = roomById.get(roomType)!;
  const W = w + 2;
  const H = h + 4;
  const state = createSimState({ seed: 1, width: W, height: H, money: 1e9 });
  const run = (cmd: Parameters<typeof applyCommand>[1]) => {
    const r = applyCommand(state, cmd);
    if (!r.ok) throw new Error(`${JSON.stringify(cmd)}: ${r.error}`);
  };
  run({ type: "build_floor", floor: 0, rect: { x: 0, y: 0, w: W, h: H } });
  const side = WallType.Standard;
  run({ type: "build_walls", floor: 0, rect: { x: 0, y: 0, w: W, h: 1 }, wall: side });
  run({ type: "build_walls", floor: 0, rect: { x: 0, y: 1, w: 1, h }, wall: side });
  run({ type: "build_walls", floor: 0, rect: { x: W - 1, y: 1, w: 1, h }, wall: side });
  if (def.enclosed || walled) {
    run({ type: "build_walls", floor: 0, rect: { x: 0, y: h + 1, w: W, h: 1 }, wall: side });
    const door = { type: "place_object", floor: 0, defId: "door_single" } as const;
    run({ ...door, x: Math.floor(W / 2), y: h + 1, rotation: 0 });
  }
  run({ type: "zone", floor: 0, rect: { x: 1, y: 1, w, h }, roomType });
  // Rooms that must open onto another get one, across the corridor below.
  for (const c of def.connectedTo) {
    run({ type: "zone", floor: 0, rect: { x: 1, y: h + 1, w, h: 2 }, roomType: c.roomType });
  }
  return state;
}

function shapeKey(defId: string): string {
  const e = equipmentById.get(defId)!;
  return JSON.stringify([e.footprint, e.access, e.mount]);
}

export function fitRoom(
  roomType: string,
  w: number,
  h: number,
  { nodeLimit = 300_000, walled = false } = {},
): FitResult {
  const state = buildRoom(roomType, w, h, walled);
  const items = requiredItems(roomType);
  const tiles: { x: number; y: number }[] = [];
  for (let y = 1; y <= h; y++) for (let x = 1; x <= w; x++) tiles.push({ x, y });
  const layout: string[] = [];
  let nodes = 0;

  const valid = () => roomAt(state, 0, 1, 1)?.valid ?? false;
  const bedSpaceFailing = () =>
    roomAt(state, 0, 1, 1)?.checks.some(
      (c) => c.label === "Clear space both sides of each bed" && !c.ok,
    ) ?? false;

  const search = (k: number, minTile: number): boolean => {
    if (k === items.length) return valid();
    const defId = items[k]!;
    // Items with the same shape and access rules are interchangeable, so
    // consecutive ones only try later tiles (symmetry breaking).
    const start = k > 0 && shapeKey(items[k - 1]!) === shapeKey(defId) ? minTile : 0;
    for (let t = start; t < tiles.length; t++) {
      for (const rotation of [0, 1, 2, 3] as Rotation[]) {
        if (++nodes > nodeLimit) return false;
        const { x, y } = tiles[t]!;
        const cmd = { type: "place_object", floor: 0, defId, x, y, rotation } as const;
        if (!planCommand(state, cmd).ok) continue;
        const money = state.money;
        applyCommand(state, cmd);
        const placed = state.nextObjectId - 1;
        layout.push(`${defId}@${x},${y} r${rotation}`);
        // Placing more items can only block bed sides, never clear them, so a
        // failing bed-space check can't recover: prune.
        if (!bedSpaceFailing() && search(k + 1, t + 1)) return true;
        layout.pop();
        applyCommand(state, { type: "remove_object", floor: 0, id: placed });
        // Selling refunds only half, so restore the cash or a long search goes broke.
        state.money = money;
      }
    }
    return false;
  };

  const ok = search(0, 0);
  const room = roomAt(state, 0, 1, 1);
  return {
    ok,
    layout: ok ? layout : [],
    exhausted: nodes > nodeLimit,
    nodes,
    failing: ok ? [] : (room?.checks.filter((c) => !c.ok).map((c) => c.label) ?? []),
  };
}
