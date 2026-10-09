/**
 * Save file encoding (ARCHITECTURE §8).
 *
 * A save is plain JSON: { format, version, meta, state }. Typed arrays are
 * stored as base64, and id-keyed records (objects, patients, staff, jobs,
 * ambulances) as
 * arrays. Derived data (rooms, the roomId, objectId and mountId grids) is not
 * saved, nor are pending notifications; it is rebuilt on load so it can never disagree with the layout.
 * Loading runs migrations for older versions and then validates with Zod, so
 * a corrupt or hand-edited file fails with a readable message.
 */
import { z } from "zod";
import { conditionById, objectDef } from "@data/catalogue";
import { staffRoleIds } from "@data/schema";
import { SIM_STATE_VERSION, type PlacedObject, type SimState } from "@sim/state";
import { clockFromTick, formatClock } from "@sim/time";
import { createFloorGrid, tileIndex, type FloorGrid } from "@sim/world/grid";
import { layerOf, objectRect } from "@sim/world/objects";
import { detectRooms } from "@sim/world/rooms";
import { fromBase64, toBase64 } from "./base64";
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
  land: z.string(),
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

const int = z.number().int();
const rectSchema = z.object({ x: int, y: int, w: int.min(0), h: int.min(0) });
const rotationSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const floorIndex = int.min(0);
const pointSchema = z.object({ x: int, y: int });

const siteSchema = z.object({
  road: rectSchema,
  pavements: z.tuple([rectSchema, rectSchema]),
  busStop: pointSchema,
});

/** Every build command, as stored in a saved plan. */
const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("build_floor"), floor: floorIndex, rect: rectSchema }),
  z.object({
    type: z.literal("pave"),
    floor: floorIndex,
    rect: rectSchema,
    surface: z.enum(["path", "road"]),
  }),
  z.object({ type: z.literal("remove_floor"), floor: floorIndex, rect: rectSchema }),
  z.object({
    type: z.literal("build_walls"),
    floor: floorIndex,
    rect: rectSchema,
    wall: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  }),
  z.object({ type: z.literal("demolish"), floor: floorIndex, rect: rectSchema }),
  z.object({
    type: z.literal("zone"),
    floor: floorIndex,
    rect: rectSchema,
    roomType: z.string().nullable(),
  }),
  z.object({
    type: z.literal("place_object"),
    floor: floorIndex,
    defId: z.string(),
    x: int,
    y: int,
    rotation: rotationSchema,
  }),
  z.object({ type: z.literal("remove_objects"), floor: floorIndex, rect: rectSchema }),
  z.object({ type: z.literal("remove_object"), floor: floorIndex, id: int.positive() }),
  z.object({
    type: z.literal("move_object"),
    floor: floorIndex,
    id: int.positive(),
    x: int,
    y: int,
    rotation: rotationSchema,
  }),
]);

const num = z.number().finite();
const nullableInt = int.nullable();

const agentFields = {
  id: int.positive(),
  name: z.string(),
  x: num,
  y: num,
  prevX: num,
  prevY: num,
  path: z.array(num).refine((p) => p.length % 2 === 0, "path must be x, y pairs"),
  dest: z.object({ x: num, y: num, ax: int, ay: int, blocked: int }).nullable(),
  pathVersion: int.min(0),
};

const patientSchema = z.object({
  ...agentFields,
  conditionId: z.string().refine((id) => conditionById.has(id), "unknown condition"),
  category: int.min(0).max(5),
  stage: z.enum([
    "awaiting_handover",
    "queueing",
    "booking",
    "waiting_triage",
    "called_triage",
    "triage",
    "waiting_treatment",
    "called_treatment",
    "in_cubicle",
    "collapsed",
    "awaiting_bed",
    "transferring",
    "on_ward",
    "deceased",
    "to_mortuary",
    "in_mortuary",
    "leaving",
  ]),
  step: int.min(0),
  seat: z.object({ objectId: int.positive(), slot: int.min(0) }).nullable(),
  standing: z.object({ x: num, y: num }).nullable(),
  bed: nullableInt,
  desk: nullableInt,
  bookingLeft: int,
  toilet: z.object({ objectId: int.positive(), left: int }).nullable(),
  ambulanceId: nullableInt,
  deterioration: z.object({ onset: int, crash: int, noticed: nullableInt }).nullable(),
  obs: z.object({ tick: int, news: int.min(0) }).nullable(),
  mood: num,
  bladder: num,
  bladderRate: num,
  times: z.object({
    arrived: int,
    booked: nullableInt,
    triaged: nullableInt,
    seen: nullableInt,
    decided: nullableInt,
    admitted: nullableInt,
    left: nullableInt,
  }),
  stayUntil: nullableInt,
  endOfLife: z.boolean(),
  death: z
    .object({
      tick: int,
      expected: z.boolean(),
      where: z.string(),
      verified: nullableInt,
      familyTold: nullableInt,
      lastOffices: nullableInt,
      inMortuary: nullableInt,
      fridge: z.object({ objectId: int.positive(), slot: int.min(0) }).nullable(),
      meReviewed: nullableInt,
      coroner: z.boolean(),
      releaseAt: nullableInt,
    })
    .nullable(),
  outcome: z.enum(["discharged", "lwbs", "transferred", "transferred_out", "died"]).nullable(),
});

const staffSchema = z.object({
  ...agentFields,
  role: z.enum(staffRoleIds),
  jobId: nullableInt,
  desk: nullableInt,
  hiredTick: int.min(0),
  morale: num.min(0).max(100),
});

const jobSchema = z.object({
  id: int.positive(),
  kind: z.enum([
    "transfer",
    "ward_discharge",
    "handover",
    "triage",
    "treat",
    "obs",
    "resus",
    "clean_cubicle",
    "clean_toilet",
    "verify_death",
    "break_news",
    "last_offices",
    "to_mortuary",
    "me_review",
    "debrief",
  ]),
  roles: z.array(z.enum(staffRoleIds)).min(1),
  patientId: nullableInt,
  objectId: nullableInt,
  roomType: z.string(),
  capabilities: z.array(z.string()),
  step: int.min(0),
  dueTick: int,
  durationTicks: int.positive(),
  progress: int.min(0),
  staffId: nullableInt,
  state: z.enum(["open", "assigned", "working"]),
  createdTick: int.min(0),
});

const spaceSchema = z.object({ x: int, y: int, w: int.positive(), h: int.positive() });
const ambulanceSchema = z.object({
  id: int.positive(),
  arrived: int.min(0),
  phase: z.enum(["arriving", "parked", "leaving"]),
  space: spaceSchema.nullable(),
  x: num,
  y: num,
  prevX: num,
  prevY: num,
  route: z.array(int),
  routeVersion: int.min(0),
  from: z.union([z.literal(0), z.literal(1)]),
  patientId: nullableInt,
  handedOver: nullableInt,
  leaveAt: nullableInt,
});

const ledgerSchema = z.object({ tariff: num, salaries: num, upkeep: num });
const statsSchema = z.object({
  arrivals: int.min(0),
  discharged: int.min(0),
  lwbs: int.min(0),
  transferred: int.min(0),
  incidents: int.min(0),
  ambulances: int.min(0),
  deflected: int.min(0),
  handovers: int.min(0),
  handoverMins: num,
  handoversOver30: int.min(0),
  handoversOver60: int.min(0),
  admissions: int.min(0),
  bedWaitMins: num,
  bedWaitsOver4h: int.min(0),
  bedWaitsOver12h: int.min(0),
  wardDischarges: int.min(0),
  transfersOut: int.min(0),
  deaths: int.min(0),
  unexpectedDeaths: int.min(0),
  complaints: int.min(0),
  within4h: int.min(0),
  departures: int.min(0),
  triaged: int.min(0),
  triageWaitMins: num,
  timeInDeptMins: num,
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
    site: siteSchema.nullable(),
    objects: z.array(objectSchema),
    nextObjectId: z.number().int().positive(),
    plan: z.array(z.object({ cmd: commandSchema, createdId: int.positive().optional() })),
    layoutVersion: int.min(0),
    patients: z.array(patientSchema),
    staff: z.array(staffSchema),
    nextAgentId: int.positive(),
    jobs: z.array(jobSchema),
    nextJobId: int.positive(),
    ambulances: z.array(ambulanceSchema),
    nextAmbulanceId: int.positive(),
    reserved: z.record(z.string(), int.positive()),
    dirt: z.record(z.string(), int.min(0)),
    today: z.object({ ledger: ledgerSchema, stats: statsSchema }),
    history: z.array(z.object({ day: int.positive(), ledger: ledgerSchema, stats: statsSchema })),
    settings: z.object({
      catchment: int.min(1_000).max(10_000_000),
      patientVolume: num.min(0).max(10),
    }),
    alerts: z.record(z.string(), int),
    incidents: z.array(
      z.object({
        id: int.positive(),
        tick: int.min(0),
        patientId: int.positive(),
        patientName: z.string(),
        conditionId: z.string(),
        summary: z.string(),
        where: z.string(),
        at: z.object({ x: int, y: int }),
        causes: z.array(z.string()),
      }),
    ),
    nextIncidentId: int.positive(),
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
        land: toBase64(g.land),
        zone: toBase64(g.zone),
      })),
      site: state.site,
      objects: Object.values(state.objects),
      nextObjectId: state.nextObjectId,
      plan: state.plan,
      layoutVersion: state.layoutVersion,
      patients: Object.values(state.patients),
      staff: Object.values(state.staff),
      nextAgentId: state.nextAgentId,
      jobs: Object.values(state.jobs),
      nextJobId: state.nextJobId,
      ambulances: Object.values(state.ambulances),
      nextAmbulanceId: state.nextAmbulanceId,
      reserved: state.reserved,
      dirt: state.dirt,
      today: state.today,
      history: state.history,
      settings: state.settings,
      alerts: state.alerts,
      incidents: state.incidents,
      nextIncidentId: state.nextIncidentId,
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
    grid.floorType.set(layer(f.floorType, size, `floor ${n} floorType`));
    grid.wall.set(layer(f.wall, size, `floor ${n} wall`));
    grid.door.set(layer(f.door, size, `floor ${n} door`));
    grid.land.set(layer(f.land, size, `floor ${n} land`));
    grid.zone.set(layer(f.zone, size, `floor ${n} zone`));
    return grid;
  });

  const state: SimState = {
    version: SIM_STATE_VERSION,
    seed: s.seed,
    rng: [s.rng[0], s.rng[1], s.rng[2], s.rng[3]],
    tick: s.tick,
    money: s.money,
    floors,
    site: s.site,
    objects: {},
    nextObjectId: s.nextObjectId,
    // Checked when the game builds its plan preview, which drops steps that no longer fit.
    plan: s.plan.map(({ cmd, createdId }) =>
      createdId === undefined ? { cmd } : { cmd, createdId },
    ),
    layoutVersion: s.layoutVersion,
    patients: byId(s.patients, "patient"),
    staff: byId(s.staff, "staff member"),
    nextAgentId: s.nextAgentId,
    jobs: byId(s.jobs, "job"),
    nextJobId: s.nextJobId,
    ambulances: byId(s.ambulances, "ambulance"),
    nextAmbulanceId: s.nextAmbulanceId,
    reserved: { ...s.reserved },
    dirt: Object.fromEntries(Object.entries(s.dirt).map(([k, v]) => [Number(k), v])),
    today: s.today,
    history: s.history,
    settings: { ...s.settings },
    alerts: { ...s.alerts },
    incidents: s.incidents,
    nextIncidentId: s.nextIncidentId,
    events: [],
    rooms: [],
    objectRoom: {},
  };
  for (const p of Object.values(state.patients)) {
    if (p.id >= state.nextAgentId) throw new SaveError(`Patient id ${p.id} out of range`);
  }
  for (const st of Object.values(state.staff)) {
    if (st.id >= state.nextAgentId) throw new SaveError(`Staff id ${st.id} out of range`);
  }
  for (const obj of s.objects) restoreObject(state, floors, obj);
  detectRooms(state);
  return { meta, state };
}

/** Rebuilds an id-keyed record, rejecting duplicate ids. */
function byId<T extends { id: number }>(items: T[], what: string): Record<number, T> {
  const out: Record<number, T> = {};
  for (const item of items) {
    if (out[item.id]) throw new SaveError(`Duplicate ${what} id ${item.id}`);
    out[item.id] = item;
  }
  return out;
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

/** Decodes one saved grid layer, checking its size. */
function layer(b64: string, expectedLength: number, what: string): Uint8Array {
  let out: Uint8Array;
  try {
    out = fromBase64(b64);
  } catch {
    throw new SaveError(`Corrupt data in ${what}`);
  }
  if (out.length !== expectedLength) throw new SaveError(`Wrong size for ${what}`);
  return out;
}
