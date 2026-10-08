/**
 * Save file encoding (ARCHITECTURE §8).
 *
 * A save is plain JSON: { format, version, meta, state }. Typed arrays are
 * stored as base64. Derived data (rooms, the roomId, objectId and mountId grids) is
 * not saved; it is rebuilt on load so it can never disagree with the layout.
 * Loading runs migrations for older versions and then validates with Zod, so
 * a corrupt or hand-edited file fails with a readable message.
 */
import { z } from "zod";
import { objectDef } from "@data/catalogue";
import { SIM_STATE_VERSION, type PlacedObject, type SimState } from "@sim/state";
import { clockFromTick, formatClock } from "@sim/time";
import { createFloorGrid, tileIndex, type FloorGrid } from "@sim/world/grid";
import { layerOf, objectRect } from "@sim/world/objects";
import { detectRooms } from "@sim/world/rooms";
import { migrate } from "./migrations";

export const SAVE_FORMAT = "hospital-save";

export interface SaveMeta {
  name: string;
  /** ISO timestamp. */
  savedAt: string;
  /** In-game time, e.g. "Day 3  14:20". */
  gameTime: string;
  money: number;
}

export class SaveError extends Error {}

const u32 = z.number().int().min(0).max(0xffffffff);

const floorSchema = z.object({
  width: z.number().int().positive().max(1000),
  height: z.number().int().positive().max(1000),
  floorType: z.string(),
  wall: z.string(),
  door: z.string(),
  zone: z.string(),
});

const objectSchema = z.object({
  id: z.number().int().positive(),
  defId: z.string(),
  floor: z.number().int().min(0),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  rotation: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
});

const saveSchema = z.object({
  format: z.literal(SAVE_FORMAT),
  version: z.literal(SIM_STATE_VERSION),
  meta: z.object({
    name: z.string(),
    savedAt: z.string(),
    gameTime: z.string(),
    money: z.number(),
  }),
  state: z.object({
    seed: u32,
    rng: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
    tick: z.number().int().min(0),
    money: z.number().finite(),
    floors: z.array(floorSchema).min(1),
    objects: z.array(objectSchema),
    nextObjectId: z.number().int().positive(),
  }),
});

export type SaveFile = z.input<typeof saveSchema>;

export function encodeSave(state: SimState, name: string, now = new Date()): SaveFile {
  return {
    format: SAVE_FORMAT,
    version: SIM_STATE_VERSION,
    meta: {
      name,
      savedAt: now.toISOString(),
      gameTime: formatClock(clockFromTick(state.tick)),
      money: state.money,
    },
    state: {
      seed: state.seed,
      rng: [...state.rng],
      tick: state.tick,
      money: state.money,
      floors: state.floors.map((g) => ({
        width: g.width,
        height: g.height,
        floorType: toBase64(g.floorType),
        wall: toBase64(g.wall),
        door: toBase64(g.door),
        zone: toBase64(g.zone),
      })),
      objects: Object.values(state.objects),
      nextObjectId: state.nextObjectId,
    },
  };
}

/** Parses a save (already JSON.parsed) into a ready-to-run SimState. */
export function decodeSave(raw: unknown): { meta: SaveMeta; state: SimState } {
  const parsed = saveSchema.safeParse(migrate(raw));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "file";
    throw new SaveError(`Not a valid save (${where}: ${first?.message ?? "unknown problem"})`);
  }
  const { meta, state: s } = parsed.data;

  const floors = s.floors.map((f, n) => {
    const grid = createFloorGrid(f.width, f.height);
    const size = f.width * f.height;
    grid.floorType.set(fromBase64(f.floorType, size, `floor ${n} floorType`));
    grid.wall.set(fromBase64(f.wall, size, `floor ${n} wall`));
    grid.door.set(fromBase64(f.door, size, `floor ${n} door`));
    grid.zone.set(fromBase64(f.zone, size, `floor ${n} zone`));
    return grid;
  });

  const state: SimState = {
    version: SIM_STATE_VERSION,
    seed: s.seed,
    rng: [s.rng[0], s.rng[1], s.rng[2], s.rng[3]],
    tick: s.tick,
    money: s.money,
    floors,
    objects: {},
    nextObjectId: s.nextObjectId,
    rooms: [],
  };
  for (const obj of s.objects) restoreObject(state, floors, obj);
  detectRooms(state);
  return { meta, state };
}

function restoreObject(state: SimState, floors: FloorGrid[], obj: PlacedObject): void {
  const grid = floors[obj.floor];
  if (!objectDef(obj.defId)) throw new SaveError(`Unknown item "${obj.defId}" in save`);
  if (obj.id >= state.nextObjectId) throw new SaveError(`Object id ${obj.id} out of range`);
  const r = objectRect(obj);
  if (!grid || r.x + r.w > grid.width || r.y + r.h > grid.height) {
    throw new SaveError(`Object ${obj.id} is off the map`);
  }
  const layer = layerOf(grid, obj.defId);
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = tileIndex(grid, x, y);
      if (layer[i] !== -1) throw new SaveError(`Objects overlap at ${x}, ${y}`);
      layer[i] = obj.id;
    }
  }
  state.objects[obj.id] = { ...obj };
}

const CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromBase64(b64: string, expectedLength: number, what: string): Uint8Array {
  let s: string;
  try {
    s = atob(b64);
  } catch {
    throw new SaveError(`Corrupt data in ${what}`);
  }
  if (s.length !== expectedLength) throw new SaveError(`Wrong size for ${what}`);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
