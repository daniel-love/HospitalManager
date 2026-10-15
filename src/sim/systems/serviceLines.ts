/**
 * Service-line reporting (GAME_DESIGN §8.1), like a PHS trust's: every
 * pound of income and running cost is booked to a department as well as to
 * its ledger line, so the Finance dialog can show what each department
 * earns, what it costs directly, and the contribution it leaves towards the
 * shared costs.
 *
 * - Income goes where the care was given: an A&E attendance to A&E, an
 *   emergency admission's stay to Wards, an operation to Theatres, a clinic
 *   appointment to Outpatients. A planned inpatient's tariff is split between
 *   Theatres and Wards (SERVICE_SPLIT). The block contract is split as it
 *   was sized (systems/funding.ts emergencyValueByLine).
 * - Drugs and supplies go with the income they were used for.
 * - Pay goes where each person was working that hour: the department of the
 *   room they're in. Hours that aren't in a department's room (corridors,
 *   the staff room, at home) follow where they've been working lately.
 *   Porters and cleaners are support services; radiographers and biomedical
 *   scientists are Diagnostics; theatre practitioners are Theatres.
 * - Equipment upkeep and estates go to the department whose room it's in
 *   (the room catalogue's department); corridors, shared waiting areas,
 *   staff areas, toilets and the mortuary are support.
 * - Diagnostics and support earn nothing of their own: they're shared
 *   costs, below the line, as is loan interest (support).
 */
import { roomById } from "@data/catalogue";
import { SERVICE_SPLIT } from "@data/economy";
import type { RoomDepartment, StaffRoleId } from "@data/schema";
import { SERVICE_LINES, onSite, type Ledger, type ServiceLine, type Staff } from "../agents";
import type { SimState } from "../state";
import { FloorType } from "../world/grid";
import { roomAt } from "../world/rooms";

/** Service lines for the room catalogue's departments; the rest (shared space, staff areas) are support. */
const LINE_OF_DEPARTMENT: Partial<Record<RoomDepartment, ServiceLine>> = {
  "A&E": "ae",
  Inpatient: "wards",
  Theatres: "theatres",
  Outpatients: "outpatients",
  Diagnostics: "diagnostics",
};

/** Rooms whose catalogue department isn't who pays for them: idle staff's bases are shared. */
const SHARED_ROOMS = new Set(["staff_base"]);

/** The service line a room type belongs to. */
export function lineOfRoom(typeId: string): ServiceLine {
  if (SHARED_ROOMS.has(typeId)) return "support";
  const def = roomById.get(typeId);
  return (def && LINE_OF_DEPARTMENT[def.department]) ?? "support";
}

/** Roles that belong to one department wherever they are. */
const FIXED_LINE: Partial<Record<StaffRoleId, ServiceLine>> = {
  porter: "support",
  cleaner: "support",
  radiographer: "diagnostics",
  biomedical_scientist: "diagnostics",
  theatre_practitioner: "theatres",
  discharge_coordinator: "wards",
  clinical_engineer: "support",
};

/** Where someone's hours go before they've been seen working anywhere. */
const DEFAULT_LINE: Record<StaffRoleId, ServiceLine> = {
  consultant: "wards",
  registrar: "wards",
  junior_doctor: "ae",
  nurse: "wards",
  nurse_practitioner: "ae",
  radiographer: "diagnostics",
  biomedical_scientist: "diagnostics",
  theatre_practitioner: "theatres",
  porter: "support",
  cleaner: "support",
  receptionist: "ae",
  discharge_coordinator: "wards",
  clinical_engineer: "support",
};

/** A role's default department; a Private Hospital has no A&E, so its doctors are ward doctors. */
function defaultLine(state: SimState, role: StaffRoleId): ServiceLine {
  const line = DEFAULT_LINE[role];
  if (line !== "ae" || state.funding !== "private") return line;
  return role === "receptionist" ? "outpatients" : "wards";
}

/** Where to book an amount: one department, or shares of several (summing to 1). */
export type Where = ServiceLine | Partial<Record<ServiceLine, number>>;

/** Books an amount to a ledger line, today, overall and by department. */
export function book(state: SimState, key: keyof Ledger, amount: number, where: Where): void {
  if (amount === 0) return;
  state.today.ledger[key] += amount;
  const services = state.today.services;
  if (typeof where === "string") {
    services[where][key] += amount;
    return;
  }
  for (const line of SERVICE_LINES) {
    const share = where[line];
    if (share) services[line][key] += amount * share;
  }
}

/** A planned operation's income: day cases are all Theatres, inpatients share with Wards. */
export function plannedWhere(dayCase: boolean): Where {
  if (dayCase) return "theatres";
  return { theatres: 1 - SERVICE_SPLIT.plannedStayShare, wards: SERVICE_SPLIT.plannedStayShare };
}

/** The department of the room at a tile, or null outside any room. */
function lineAt(state: SimState, x: number, y: number): ServiceLine | null {
  const room = roomAt(state, 0, Math.round(x), Math.round(y));
  return room ? lineOfRoom(room.typeId) : null;
}

/**
 * Where each person has been working lately, as decaying hours by
 * department. Reporting only, so it isn't saved: after loading, hours
 * follow the role's default until they're seen at work again.
 */
const recent = new WeakMap<SimState, Map<number, Partial<Record<ServiceLine, number>>>>();
/** Each hour, earlier hours count this much less: about a day's half-life. */
const DECAY = 0.97;

/**
 * Where this hour of someone's pay goes: the department they're working in
 * now, or else where they've worked lately.
 */
export function staffWhere(state: SimState, s: Staff): Where {
  const fixed = FIXED_LINE[s.role];
  if (fixed) return fixed;
  let byStaff = recent.get(state);
  if (!byStaff) recent.set(state, (byStaff = new Map()));
  const here = onSite(s) ? lineAt(state, s.x, s.y) : null;
  // Corridors and staff areas don't say which department someone works for.
  if (here !== null && here !== "support") {
    const w = byStaff.get(s.id) ?? {};
    for (const line of SERVICE_LINES) if (w[line]) w[line] *= DECAY;
    w[here] = (w[here] ?? 0) + 1;
    byStaff.set(s.id, w);
    return here;
  }
  const w = byStaff.get(s.id);
  const total = w ? SERVICE_LINES.reduce((n, l) => n + (w[l] ?? 0), 0) : 0;
  if (!w || total === 0) return defaultLine(state, s.role);
  const shares: Partial<Record<ServiceLine, number>> = {};
  for (const line of SERVICE_LINES) if (w[line]) shares[line] = w[line] / total;
  return shares;
}

/** Forgets someone who has left. */
export function forgetStaff(state: SimState, id: number): void {
  recent.get(state)?.delete(id);
}

const tileCache = new WeakMap<SimState, { version: number; tiles: Record<ServiceLine, number> }>();

/** Floor tiles built, by the department whose room they're in (support outside rooms). */
export function tilesByLine(state: SimState): Record<ServiceLine, number> {
  const hit = tileCache.get(state);
  if (hit && hit.version === state.layoutVersion) return hit.tiles;
  const tiles = Object.fromEntries(SERVICE_LINES.map((l) => [l, 0])) as Record<ServiceLine, number>;
  for (const g of state.floors) {
    for (let i = 0; i < g.floorType.length; i++) {
      if (g.floorType[i] !== FloorType.Floor) continue;
      const id = g.roomId[i]!;
      const room = id === 0 ? undefined : state.rooms[id - 1];
      tiles[room ? lineOfRoom(room.typeId) : "support"]++;
    }
  }
  tileCache.set(state, { version: state.layoutVersion, tiles });
  return tiles;
}

/** The department of the room a placed object is in (support outside rooms). */
export function objectLine(state: SimState, objectId: number): ServiceLine {
  const id = state.objectRoom[objectId];
  const room = id === undefined ? undefined : state.rooms[id - 1];
  return room ? lineOfRoom(room.typeId) : "support";
}
