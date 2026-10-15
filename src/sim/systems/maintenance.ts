/**
 * Equipment breakdowns, repairs and maintenance, and power cuts (GAME_DESIGN
 * §9). Every item that can break down (reliability under 1) wears with age
 * and use; the more worn, the likelier it is to break, from half its rated
 * chance when new to two and a half times when worn out. A broken item is
 * out of service, as if it weren't there: a room that needs it stops
 * working (world/service.ts). Clinical Engineers repair it, then, between
 * repairs, do planned preventive maintenance on anything worn, which resets
 * its wear. Without one, broken kit stays broken.
 *
 * Breakdowns, like other events, are off with Settings → Events off (test
 * fixtures), and never draw on the random stream then.
 */
import { equipmentById, roomById } from "@data/catalogue";
import { MAINTENANCE } from "@data/maintenance";
import type { PlacedObject, Room, SimState } from "../state";
import { emit, warn } from "../events";
import { bedside, frontOf, holder, isCouch } from "../places";
import type { Point } from "../agents";
import { isStandable, objectRect, sideTiles } from "../world/objects";
import { nextFloat } from "../rng";
import { TICKS_PER_MINUTE } from "../time";
import { detectRooms, roomOfObject } from "../world/rooms";
import { isPowered, powerCut } from "../world/service";
import { jobsForObject, postJob, ticksFor } from "./jobBoard";
import { book, objectLine } from "./serviceLines";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;

/** Rooms lose (or regain) what's out of service: re-evaluated like a layout change. */
export function refreshRooms(state: SimState): void {
  state.layoutVersion++;
  detectRooms(state);
}

function canBreak(o: PlacedObject): boolean {
  const def = equipmentById.get(o.defId);
  return !!def && def.reliability < 1;
}

/** How much likelier than rated it is to break, from its wear. */
export function wearFactor(wear: number): number {
  return MAINTENANCE.wearFactorAtZero + MAINTENANCE.perWear * wear;
}

function name(o: PlacedObject): string {
  return equipmentById.get(o.defId)?.name ?? o.defId;
}

function where(state: SimState, o: PlacedObject): string {
  const room = roomOfObject(state, o.id);
  const def = room && roomById.get(room.typeId);
  return def ? ` in the ${def.name}` : "";
}

/** Minutes a repair takes, by the item's price. */
function repairMins(o: PlacedObject): [number, number] {
  const cost = equipmentById.get(o.defId)?.cost ?? 0;
  const m = MAINTENANCE.repairMins;
  return cost >= MAINTENANCE.largeFrom
    ? m.large
    : cost >= MAINTENANCE.mediumFrom
      ? m.medium
      : m.small;
}

function hasEngineer(state: SimState): boolean {
  return Object.values(state.staff).some((s) => s.role === "clinical_engineer");
}

/** It's broken: out of service, and an engineer is asked to repair it. */
export function breakDown(state: SimState, o: PlacedObject): void {
  const m = (state.maintenance[o.id] ??= { wear: 0, broken: null });
  if (m.broken !== null) return;
  m.broken = state.tick;
  for (const j of jobsForObject(state, o.id)) if (j.kind === "maintain") j.kind = "repair";
  postRepair(state, o, "repair");
  refreshRooms(state);
  if (hasEngineer(state)) {
    emit(
      state,
      `${name(o)}${where(state, o)} has broken down: a clinical engineer will repair it`,
      "warn",
      o,
    );
  } else {
    emit(
      state,
      `${name(o)}${where(state, o)} has broken down. With no clinical engineer, it stays out of service (Staff → Hire)`,
      "bad",
      o,
    );
  }
}

function postRepair(state: SimState, o: PlacedObject, kind: "repair" | "maintain"): void {
  if (jobsForObject(state, o.id).some((j) => j.kind === "repair" || j.kind === "maintain")) return;
  const [lo, hi] = repairMins(o);
  const mins: [number, number] =
    kind === "repair"
      ? [lo, hi]
      : [Math.round(lo * MAINTENANCE.ppmShare), Math.round(hi * MAINTENANCE.ppmShare)];
  postJob(state, {
    kind,
    roles: ["clinical_engineer"],
    objectId: o.id,
    roomType: roomOfObject(state, o.id)?.typeId ?? "",
    // Repairs at once; maintenance fits in around them.
    dueTick: kind === "repair" ? state.tick : state.tick + 24 * TICKS_PER_HOUR,
    durationTicks: ticksFor(state.rng, mins),
  });
}

/** An engineer finished a repair: back in service, at some wear; spare parts paid for. */
export function repaired(state: SimState, o: PlacedObject): void {
  const parts = (equipmentById.get(o.defId)?.cost ?? 0) * MAINTENANCE.partsShare;
  state.money -= parts;
  book(state, "upkeep", parts, objectLine(state, o.id));
  state.maintenance[o.id] = { wear: MAINTENANCE.wearAfterRepair, broken: null };
  refreshRooms(state);
  emit(state, `${name(o)}${where(state, o)} has been repaired and is back in service`, "info", o);
}

/** Planned preventive maintenance done: as good as new. */
export function maintained(state: SimState, o: PlacedObject): void {
  const m = state.maintenance[o.id];
  if (m && m.broken === null) m.wear = 0;
}

/** Whether the power was off last time we looked, to notice it going and coming back. */
const lastCut = new WeakMap<SimState, boolean>();

/** Each tick: notices the power going or coming back; each hour, wear, breakdowns and maintenance. */
export function updateMaintenance(state: SimState): void {
  const cut = powerCut(state);
  if (cut !== (lastCut.get(state) ?? false)) {
    lastCut.set(state, cut);
    refreshRooms(state);
    const off = Object.values(state.objects).filter((o) => !isPowered(state, o.id)).length;
    if (cut) {
      emit(
        state,
        off === 0
          ? "Power cut: the standby generators have taken over everything."
          : `Power cut: ${off} powered ${off === 1 ? "item is" : "items are"} without power, beyond what the standby generators cover. Rooms that need them have stopped working.`,
        off === 0 ? "warn" : "bad",
        undefined,
        undefined,
        undefined,
        "events",
      );
    } else emit(state, "The power is back on.", "info");
  }
  if (state.tick % TICKS_PER_HOUR !== 0) return;
  const breakdowns = state.settings.eventFrequency !== "off";
  const engineers = hasEngineer(state);
  for (const o of Object.values(state.objects)) {
    if (!canBreak(o)) continue;
    const m = (state.maintenance[o.id] ??= { wear: 0, broken: null });
    if (m.broken !== null) continue;
    const inUse = holder(state, o.id, 0) !== undefined;
    m.wear = Math.min(
      100,
      m.wear + MAINTENANCE.wearPerDay / 24 + (inUse ? MAINTENANCE.wearPerHourInUse : 0),
    );
    if (engineers && m.wear >= MAINTENANCE.ppmFrom) postRepair(state, o, "maintain");
    if (!breakdowns) continue;
    const def = equipmentById.get(o.defId)!;
    const chance = ((1 - def.reliability) * wearFactor(m.wear)) / 24;
    if (nextFloat(state.rng) < chance) breakDown(state, o);
  }
  // Forget items that have been removed.
  if (state.tick % (24 * TICKS_PER_HOUR) === 0) {
    for (const id of Object.keys(state.maintenance)) {
      if (!state.objects[Number(id)]) delete state.maintenance[Number(id)];
    }
  }
  if (!engineers) {
    const broken = Object.values(state.maintenance).filter((m) => m.broken !== null).length;
    if (broken > 0) {
      warn(
        state,
        "broken_no_engineer",
        24 * TICKS_PER_HOUR,
        `${broken} ${broken === 1 ? "item is" : "items are"} broken down and out of service, with no clinical engineer to repair ${broken === 1 ? "it" : "them"} (Staff → Hire).`,
        "bad",
      );
    }
  }
}

/** Puts a room on the essential supply, or takes it off (pinned to one of its tiles). */
export function setEssentialRoom(state: SimState, room: Room, on: boolean): void {
  const grid = state.floors[room.floor]!;
  for (const key of Object.keys(state.essentialRooms)) {
    const [floor, tile] = key.split(":").map(Number);
    if (floor === room.floor && grid.roomId[tile!] === room.id) delete state.essentialRooms[key];
  }
  state.essentialRooms[`${room.floor}:${room.tiles[0]!}`] = on;
  // Who has power in a power cut may change.
  refreshRooms(state);
}

/** For the inspector: an item's condition, if it can break down or needs power. */
export function equipmentCondition(
  state: SimState,
  objectId: number,
): { text: string; ok: boolean } | null {
  const o = state.objects[objectId];
  const def = o && equipmentById.get(o.defId);
  if (!def || (def.reliability >= 1 && !def.power)) return null;
  const m = state.maintenance[objectId];
  if (m?.broken != null) {
    const fixing = jobsForObject(state, objectId).some(
      (j) => j.kind === "repair" && j.state === "working",
    );
    return {
      text: fixing
        ? "Broken down: being repaired"
        : hasEngineer(state)
          ? "Broken down: waiting for a clinical engineer"
          : "Broken down: no clinical engineer to repair it",
      ok: false,
    };
  }
  if (!isPowered(state, objectId))
    return { text: "No power: beyond the standby generators' cover", ok: false };
  if (def.reliability >= 1) return null;
  const wear = Math.round(m?.wear ?? 0);
  const odds = Math.round(1 / ((1 - def.reliability) * wearFactor(wear)));
  return {
    text: `Working · wear ${wear}% · breaks down about once every ${odds} days at this wear`,
    ok: wear < MAINTENANCE.ppmFrom,
  };
}

/** Where an engineer works on an item: beside a bed or couch, else any clear tile next to it, front first. */
export function engineerSpot(state: SimState, o: PlacedObject): Point {
  if (isCouch(o.defId)) return bedside(state, o);
  const grid = state.floors[o.floor]!;
  const front = frontOf(o);
  if (isStandable(grid, front.x, front.y)) return front;
  const r = objectRect(o);
  for (const side of ["back", "sides"] as const) {
    const t = sideTiles(r, o.rotation, side).find((t) => isStandable(grid, t.x, t.y));
    if (t) return t;
  }
  return front;
}
