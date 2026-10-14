/**
 * Admissions and wards (GAME_DESIGN §5.5):
 *
 *   last A&E step → referral to the specialty → its registrar or consultant
 *     reviews them on their trolley → decision to admit → wait on the A&E trolley for a ward
 *     bed and a porter → wheeled to the ward (bed-width route only) → stay
 *     for days → doctor's discharge review → home
 *
 * An admitted patient keeps their A&E trolley until a porter moves them, so
 * a full hospital backs up into A&E ("exit block"): trolleys stay occupied,
 * ambulances can't hand over, and waits grow. The A&E clock stops when they
 * reach the ward; the decision-to-admit wait ("trolley wait") is tracked
 * against the 4- and 12-hour marks. Waiting for the specialty review counts
 * towards the 4 hours too, as it does in real A&Es.
 *
 * Each ward can be given to a specialty. Patients go to their specialty's
 * ward first, then one open to any specialty, and only then to another
 * specialty's ward (an "outlier").
 */
import { conditionById, equipmentById } from "@data/catalogue";
import { MOOD_LIFT_DECISION, REFERRAL_MINS, WARD_DISCHARGE_MINS } from "@data/patients";
import { onDuty, type Job, type Patient, type Point, type Staff } from "../agents";
import { emit, warn } from "../events";
import { bedside, freeCouches, release, reserve, restPoint } from "../places";
import { chance, nextFloat } from "../rng";
import type { PlacedObject, SimState } from "../state";
import { clockFromTick, tickAt, TICKS_PER_MINUTE } from "../time";
import { tileIndex, type FloorGrid } from "../world/grid";
import { isStandable, objectRect } from "../world/objects";
import { roomOfObject } from "../world/rooms";
import { isBedPassable, isWalkable } from "../world/pathfinding";
import { earnEmergency } from "./finance";
import { dirtyCouch, jobsForPatient, postJob, removeJob, ticksFor } from "./jobBoard";
import { headTo } from "./movement";
import { die } from "./deaths";
import { leave, lift, recordDeparture } from "./patients";
import { cantOperate } from "./theatres";
import { cantAdmit, decideToTransfer } from "./transfers";
import { freeEscalationBeds } from "./escalation";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;

/** After the last A&E step: home, intensive care, or a decision to admit. */
export function finishPathway(state: SimState, p: Patient, trolley: PlacedObject): void {
  const condition = conditionById.get(p.conditionId)!;
  if (condition.outcome === "icu") {
    leave(state, p, "transferred");
    dirtyCouch(state, trolley.id);
    return;
  }
  const admission = condition.admission;
  if (admission && chance(state.rng, admission.chance)) {
    p.specialty = condition.specialty!;
    // Specialty gating (GAME_DESIGN §5.1): no ward or no team, no admission here.
    const why = cantAdmit(state, p.specialty);
    if (why) decideToTransfer(state, p, `${why}, so they can't be admitted here`);
    else refer(state, p, trolley);
    return;
  }
  lift(p, MOOD_LIFT_DECISION);
  leave(state, p, "discharged");
  dirtyCouch(state, trolley.id);
}

/**
 * Referred to their specialty: they stay on their trolley (or couch) until
 * one of its registrars or consultants comes to review them.
 */
function refer(state: SimState, p: Patient, trolley: PlacedObject): void {
  p.times.referred = state.tick;
  postJob(state, {
    kind: "referral",
    roles: ["registrar", "consultant"],
    specialty: p.specialty,
    patientId: p.id,
    objectId: trolley.id,
    roomType: roomOfObject(state, trolley.id)?.typeId ?? "majors_bay",
    // In turn, behind patients referred earlier.
    dueTick: state.tick,
    durationTicks: ticksFor(state.rng, REFERRAL_MINS),
  });
}

/** The specialty review is done: they're accepted for admission. */
export function reviewed(state: SimState, p: Patient): void {
  const stats = state.today.stats;
  stats.referrals++;
  stats.referralMins += (state.tick - (p.times.referred ?? state.tick)) / TICKS_PER_MINUTE;
  decideToAdmit(state, p);
}

/** They stay on their A&E trolley; a porter's job waits for a free ward bed. */
export function decideToAdmit(state: SimState, p: Patient): void {
  const admission = conditionById.get(p.conditionId)!.admission;
  const endOfLife = admission?.endOfLife ?? 0;
  if (endOfLife > 0 && chance(state.rng, endOfLife)) p.endOfLife = true;
  const op = admission?.operation;
  if (op && !p.endOfLife && chance(state.rng, op.chance)) {
    // They need an operation too: here if it can be done, or elsewhere.
    const specialty = op.specialty ?? p.specialty ?? conditionById.get(p.conditionId)!.specialty!;
    const why = cantOperate(state, specialty);
    if (why) {
      decideToTransfer(state, p, `${why}, so they can't have their ${op.name.toLowerCase()} here`);
      return;
    }
    p.emergencyOp = {
      specialty,
      due: state.tick + op.withinHours * TICKS_PER_HOUR,
      from: null,
      done: false,
    };
  }
  p.times.decided = state.tick;
  p.stage = "awaiting_bed";
  lift(p, MOOD_LIFT_DECISION);
  postJob(state, {
    kind: "transfer",
    roles: ["porter"],
    patientId: p.id,
    roomType: "ward",
    capabilities: ["inpatient_bed"],
    // First come, first served, behind anything urgent in A&E.
    dueTick: state.tick,
    durationTicks: 1,
  });
}

// ---------- Bed-width routes ----------

interface BedRegions {
  version: number;
  /** Bed-passable tile → connected region label (0 = not bed-passable). */
  label: Int32Array;
}
const regionCache = new WeakMap<SimState, BedRegions>();

/** Connected areas a bed can be wheeled around, labelled once per layout. */
function bedRegions(state: SimState): Int32Array {
  const cached = regionCache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached.label;
  const grid = state.floors[0]!;
  const { width, height } = grid;
  const label = new Int32Array(width * height);
  let next = 0;
  const stack: number[] = [];
  for (let start = 0; start < label.length; start++) {
    if (label[start] !== 0 || !isBedPassable(grid, start)) continue;
    label[start] = ++next;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = tileIndex(grid, nx, ny);
        if (label[n] !== 0 || !isBedPassable(grid, n)) continue;
        label[n] = next;
        stack.push(n);
      }
    }
  }
  regionCache.set(state, { version: state.layoutVersion, label });
  return label;
}

/**
 * Bed regions touching a tile: its own, or (if a bed can't stand on it) its
 * neighbours'. On a trolley, the regions it can be wheeled out into: those
 * beside any of its tiles, since it can leave head or foot first.
 */
function regionsAt(state: SimState, t: Point): Set<number> {
  const grid = state.floors[0]!;
  const label = bedRegions(state);
  const out = new Set<number>();
  if (t.x < 0 || t.y < 0 || t.x >= grid.width || t.y >= grid.height) return out;
  const id = grid.objectId[tileIndex(grid, t.x, t.y)]!;
  const obj = id === -1 ? undefined : state.objects[id];
  const r = obj ? objectRect(obj) : { x: t.x, y: t.y, w: 1, h: 1 };
  for (let y = r.y - 1; y <= r.y + r.h; y++) {
    for (let x = r.x - 1; x <= r.x + r.w; x++) {
      if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
      // Off a trolley's corners only diagonally, which a bed can't do; onto a
      // tile diagonally only as findPath allows, without cutting a corner.
      const corner = (x < r.x || x >= r.x + r.w) && (y < r.y || y >= r.y + r.h);
      if (corner && (obj || !diagonalStep(grid, x, y, t.x, t.y))) continue;
      const l = label[tileIndex(grid, x, y)]!;
      if (l !== 0) out.add(l);
    }
  }
  return out;
}

/** Whether a step diagonally between these tiles is allowed: no doors, no cut corners. */
function diagonalStep(grid: FloorGrid, x0: number, y0: number, x1: number, y1: number): boolean {
  const at = (x: number, y: number) => tileIndex(grid, x, y);
  if (grid.door[at(x0, y0)] !== 0 || grid.door[at(x1, y1)] !== 0) return false;
  return isWalkable(grid, at(x1, y0)) && isWalkable(grid, at(x0, y1));
}

/** Whether a bed can be wheeled from `from` to beside `to`. */
export function bedRouteExists(state: SimState, from: Point, to: Point): boolean {
  const a = regionsAt(state, from);
  for (const l of regionsAt(state, to)) if (a.has(l)) return true;
  return false;
}

/** Where a patient on (or off) a trolley is, as a whole tile. */
function tileOf(p: Patient): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * Patients on a trolley (Majors, Resus) are wheeled to the ward on it; ones
 * on an examination couch (Minors) can walk there with the porter.
 */
export function onTrolley(state: SimState, p: Patient): boolean {
  const bed = p.bed === null ? undefined : state.objects[p.bed];
  return !!bed && (equipmentById.get(bed.defId)?.capabilities.includes("patient_space") ?? false);
}

/**
 * Where a trolley stops beside a ward bed so the patient can be moved
 * across: a tile next to the bed (its side or its foot) that a bed can be
 * wheeled to from `from` (or that passes `canReach`). Null if there's none.
 */
export function trolleyStop(
  state: SimState,
  from: Point,
  bed: PlacedObject,
  canReach = (to: Point) => bedRouteExists(state, from, to),
): Point | null {
  const grid = state.floors[0]!;
  const r = objectRect(bed);
  for (let y = r.y - 1; y <= r.y + r.h; y++) {
    for (let x = r.x - 1; x <= r.x + r.w; x++) {
      const inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
      if (inside || !isStandable(grid, x, y)) continue;
      if (canReach({ x, y })) return { x, y };
    }
  }
  return null;
}

/**
 * The nearest free, clean ward bed the patient can get to, reserved for
 * them. On a trolley that needs a bed-width route. Null if there's none.
 * `job.step` records which: 1 wheeled on their trolley, 0 walking.
 */
export function claimWardBed(state: SimState, job: Job): Point | null {
  const p = job.patientId === null ? undefined : state.patients[job.patientId];
  if (!p || p.stage !== "awaiting_bed" || p.path.length > 0) return null;
  if (jobsForPatient(state, p.id).some((j) => j.state === "working")) return null;
  const from = tileOf(p);
  const wheeled = onTrolley(state, p);
  const reachable = (b: PlacedObject) => !wheeled || trolleyStop(state, from, b) !== null;
  const isPrivate = !!p.elective && p.elective.payer !== "nhs";
  // At the end of life, a side room for privacy if one's free.
  const bed =
    (p.endOfLife
      ? freeCouches(state, "side_room", job.capabilities, from).find(reachable)
      : undefined) ??
    bestWardBed(
      state,
      p,
      freeCouches(state, job.roomType, job.capabilities, from, isPrivate).filter(reachable),
    ) ??
    // No ward bed: with escalation open, an escalation trolley (corridor care).
    (isPrivate ? undefined : freeEscalationBeds(state, from).find(reachable));
  if (!bed) return null;
  reserve(state, bed.id, 0, p.id);
  job.objectId = bed.id;
  job.step = wheeled ? 1 : 0;
  return from;
}

/** How well a ward suits them: 0 their specialty's, 1 open to any, 2 another specialty's. */
function wardFit(state: SimState, p: Patient, bed: PlacedObject): number {
  const specialty = roomOfObject(state, bed.id)?.specialty ?? null;
  return specialty === p.specialty ? 0 : specialty === null ? 1 : 2;
}

/** The nearest of the best-fitting beds (they're sorted nearest first). */
function bestWardBed(state: SimState, p: Patient, beds: PlacedObject[]): PlacedObject | undefined {
  let best: PlacedObject | undefined;
  let bestFit = Infinity;
  for (const b of beds) {
    const fit = wardFit(state, p, b);
    if (fit < bestFit) {
      best = b;
      bestFit = fit;
    }
  }
  return best;
}

/**
 * The porter goes to the patient, then takes them to the ward bed: wheeling
 * their trolley (bed-width route only), or walking alongside.
 */
export function runTransfer(state: SimState, job: Job, porter: Staff, p: Patient): void {
  const wardBed = job.objectId === null ? undefined : state.objects[job.objectId];
  if (!wardBed) {
    // The ward bed was removed: find another.
    if (job.objectId !== null) release(state, job.objectId, 0, p.id);
    porter.jobId = null;
    job.staffId = null;
    job.state = "open";
    job.objectId = null;
    p.stage = "awaiting_bed";
    return;
  }
  if (job.state === "assigned") {
    const at =
      p.bed !== null && state.objects[p.bed] ? bedside(state, state.objects[p.bed]!) : tileOf(p);
    if (headTo(state, porter, at) !== "arrived") return;
    job.state = "working";
    p.stage = "transferring";
    if (p.bed !== null) {
      release(state, p.bed, 0, p.id);
      if (state.objects[p.bed]) dirtyCouch(state, p.bed);
    }
    p.bed = wardBed.id;
  }
  const wheeled = job.step === 1;
  const stop = wheeled ? trolleyStop(state, tileOf(p), wardBed) : null;
  let arrival = stop
    ? headTo(state, p, restPoint(wardBed), stop, true)
    : headTo(state, p, restPoint(wardBed), bedside(state, wardBed));
  if (arrival === "no_route" || (wheeled && !stop)) {
    // The route was blocked mid-way (rebuilt?): squeeze through on foot rather than strand them.
    warn(
      state,
      "no_bed_route",
      6 * TICKS_PER_HOUR,
      `A porter couldn't find a bed-width route to the ward for ${p.name}. Beds need double doors and corridors at least 2 tiles wide.`,
      "warn",
      tileOf(p),
    );
    arrival = headTo(state, p, restPoint(wardBed), bedside(state, wardBed));
  }
  // The porter pushes the bed.
  porter.prevX = porter.x;
  porter.prevY = porter.y;
  porter.x = p.x;
  porter.y = p.y;
  porter.path = [];
  porter.dest = null;
  if (arrival !== "arrived") return;
  removeJob(state, job);
  arriveOnWard(state, p);
}

/** Admitted: they've left A&E, so its clock stops; the inpatient stay begins. */
function arriveOnWard(state: SimState, p: Patient): void {
  const condition = conditionById.get(p.conditionId)!;
  p.stage = "on_ward";
  p.times.admitted = state.tick;
  if (p.bed !== null && state.objects[p.bed] && wardFit(state, p, state.objects[p.bed]!) === 2) {
    state.today.stats.outliers++;
  }
  const [lo, hi] = condition.admission?.stayHours ?? [24, 48];
  p.stayUntil = state.tick + Math.round((lo + (hi - lo) * nextFloat(state.rng)) * TICKS_PER_HOUR);
  // A planned operation's inpatient never came through A&E: no A&E figures,
  // and the inpatient tariff is paid on discharge. Nor does someone coming
  // back from an emergency operation they went to from the ward.
  if (p.elective || p.emergencyOp?.from === "ward") return;

  const stats = state.today.stats;
  // Straight from A&E to theatre: they left A&E then (systems/theatres.ts).
  const viaTheatre = p.emergencyOp?.from === "ae";
  if (!viaTheatre) recordDeparture(state, p);
  stats.admissions++;
  const wait = viaTheatre ? 0 : (state.tick - (p.times.decided ?? state.tick)) / TICKS_PER_MINUTE;
  stats.bedWaitMins += wait;
  if (wait > 4 * 60) stats.bedWaitsOver4h++;
  if (wait > 12 * 60) {
    stats.bedWaitsOver12h++;
    emit(
      state,
      `${p.name} waited ${Math.floor(wait / 60)} hours on an A&E trolley for a ward bed (a 12-hour trolley wait)`,
      "bad",
      tileOf(p),
    );
  }
  // The A&E attendance is paid now; the inpatient stay when they go home.
  earnEmergency(state, condition.tariff);
}

/** Inpatients well enough to go home get a doctor's discharge review. */
export function updateWards(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE !== 0) return;
  const c = clockFromTick(state.tick);
  const minute = c.hour * 60 + c.minute;
  // Discharge before noon: in the morning, everyone fit to go later today is reviewed now.
  const morning =
    state.policies.dischargeBeforeNoon &&
    minute >= DISCHARGE_ROUND.from &&
    minute < DISCHARGE_ROUND.to;
  const endOfDay = tickAt(c.day, 0) + DISCHARGE_ROUND.lastDischarge * TICKS_PER_MINUTE;
  if (state.policies.dischargeBeforeNoon && minute === DISCHARGE_ROUND.to) rushedRound(state);
  for (const p of Object.values(state.patients)) {
    if (p.stage !== "on_ward" || p.stayUntil === null) continue;
    const early = morning && p.stayUntil <= endOfDay;
    if (state.tick < p.stayUntil && !early) continue;
    if (p.emergencyOp && !p.emergencyOp.done) continue; // Not before their operation.
    if (p.endOfLife) {
      die(state, p, true, false);
      continue;
    }
    if (p.bed === null || jobsForPatient(state, p.id).some((j) => j.kind === "ward_discharge")) {
      continue;
    }
    postJob(state, {
      kind: "ward_discharge",
      roles: ["junior_doctor"],
      patientId: p.id,
      objectId: p.bed,
      roomType: roomOfObject(state, p.bed)?.typeId ?? "ward",
      // A&E's urgent work comes first; the ward round fits in around it
      // (unless it's a morning discharge round).
      dueTick: early ? state.tick : p.stayUntil + 4 * TICKS_PER_HOUR,
      durationTicks: ticksFor(state.rng, WARD_DISCHARGE_MINS),
    });
  }
}

/**
 * Discharge before noon (a hospital policy): between these times, ward
 * patients fit to go home before `lastDischarge` today are reviewed at once,
 * freeing their beds for A&E's afternoon peak. Times are minutes after midnight.
 */
const DISCHARGE_ROUND = { from: 8 * 60, to: 12 * 60, lastDischarge: 20 * 60, morale: 1 };

/** The morning's rush costs the ward doctors and nurses on duty a little morale. */
function rushedRound(state: SimState): void {
  for (const s of Object.values(state.staff)) {
    if ((s.role === "junior_doctor" || s.role === "nurse") && onDuty(s)) {
      s.morale = Math.max(0, s.morale - DISCHARGE_ROUND.morale);
    }
  }
}

/** Reviewed and well: home, with the inpatient tariff earned. Their bed needs making up. */
export function dischargeFromWard(state: SimState, p: Patient, bed: PlacedObject): void {
  leave(state, p, "discharged");
  dirtyCouch(state, bed.id);
}
