/**
 * The A&E walk-in patient lifecycle (GAME_DESIGN §5.5) and patient needs
 * (§5.4):
 *
 *   arrive → queue at reception → book in → wait → triage → wait
 *     → called to a cubicle or bay → treatment steps → discharge
 *
 * A patient who deteriorates unnoticed may collapse on the way
 * (systems/deterioration.ts).
 *
 * Patients decide where to be each tick and walk there; staff work arrives
 * through the job board (systems/jobs.ts). While waiting, mood falls (faster
 * when standing or desperate for the toilet), and an unhappy patient may
 * leave without being seen (LWBS).
 */
import { conditionById, roomById } from "@data/catalogue";
import {
  BOOKING_MINS,
  COMMODE_MINS,
  FOUR_HOUR_MINS,
  LWBS_ACUITY_FACTOR,
  LWBS_MAX_CHANCE_PER_MIN,
  LWBS_MOOD,
  MOOD_DECAY_IN_CUBICLE,
  MOOD_DECAY_SEATED,
  MOOD_DECAY_STANDING,
  MOOD_DECAY_TOILET,
  MOOD_LIFT_TRIAGED,
  MOOD_RECOVERY_BEING_SEEN,
  MOOD_RECOVERY_ON_WARD,
  TOILET_FIXTURES,
  TOILET_URGE,
  TOILET_USES_BEFORE_CLEAN,
  TRIAGE_CATEGORIES,
  TRIAGE_MINS,
  TRIAGE_TARGET_MINS,
  WAITING_CROWD,
} from "@data/patients";
import type { Outcome, Patient, PatientStage, Point } from "../agents";
import { emit, warn } from "../events";
import {
  bedside,
  deskStaffSpot,
  fallbackEntrance,
  freeSeat,
  freeToilet,
  toiletBlocker,
  frontOf,
  holder,
  inValidRoom,
  queueSpots,
  receptionDesks,
  release,
  reserve,
  restPoint,
  seatApproach,
  seatTile,
  siteEntrance,
  staffedDesks,
  mayWaitIn,
  standingSpot,
} from "../places";
import { chance, nextInt } from "../rng";
import type { PlacedObject, SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { crewAccess, privateRoomsCrossed } from "../world/access";
import { accessRouteExists } from "../world/accessRegions";
import { tileIndex } from "../world/grid";
import { isStandable } from "../world/objects";
import { findPath } from "../world/pathfinding";
import { roomAt, roomOfObject } from "../world/rooms";
import { earnEmergency, earnPlanned } from "./finance";
import {
  dirtyCouch,
  ESCALATED_DUE,
  hasCleaningJob,
  jobsForPatient,
  postJob,
  removeJob,
  ticksFor,
} from "./jobBoard";
import { type Arrival, headTo, stop } from "./movement";
import { leaveScanner } from "./diagnostics";
import { isEscorted, unwellToTravel } from "./escorts";
import { bedRouteExists, trolleyStop } from "./admissions";
import { withAmbulanceCrew } from "./ambulances";
import { hasTeam } from "./staffing";
import { onEscalationBed } from "./escalation";
import { hasVisitor, visitedLately } from "./visitors";
import { heatMoodDecay, heatWardMood } from "./pressure";

const TICKS_PER_HOUR = TICKS_PER_MINUTE * 60;

/** Stages where a patient is waiting to be called and may give up. */
const WAITING: ReadonlySet<PatientStage> = new Set([
  "queueing",
  "waiting_triage",
  "waiting_treatment",
]);

export function updatePatients(state: SimState): void {
  const beingSeen = new Set<number>();
  for (const j of Object.values(state.jobs)) {
    if (j.state === "working" && j.patientId !== null) beingSeen.add(j.patientId);
  }
  updateQueue(state);
  for (const p of Object.values(state.patients)) {
    updateNeeds(state, p, beingSeen.has(p.id));
    if (p.stage !== "leaving" && WAITING.has(p.stage) && p.toilet === null) maybeGiveUp(state, p);
    switch (p.stage) {
      case "queueing":
        break; // Handled by updateQueue.
      case "booking":
        updateBooking(state, p);
        break;
      case "waiting_triage":
      case "waiting_treatment":
        waitInArea(state, p, beingSeen.has(p.id));
        break;
      case "awaiting_handover":
        break; // On the stretcher at the ambulance (systems/ambulances.ts).
      case "awaiting_bed":
        // Admitted from a Minors cubicle: they sit in the Waiting Area until a porter comes.
        if (p.bed === null && inAE(p)) waitInArea(state, p, beingSeen.has(p.id));
        else toiletFromBed(state, p, beingSeen.has(p.id));
        break; // Otherwise on a trolley; porters move them (systems/admissions.ts).
      case "transferring":
      case "on_ward":
        break; // On a bed; porters move them (systems/admissions.ts).
      case "discharge_lounge":
        // Waiting for transport home (systems/discharge.ts), free to use the toilet.
        if (p.toilet) toiletTrip(state, p);
        else if (p.bladder >= TOILET_URGE && (state.tick + p.id) % 10 === 0) goToToilet(state, p);
        break;
      case "deceased":
      case "to_mortuary":
      case "in_mortuary":
        break; // See systems/deaths.ts.
      case "collapsed":
        break; // The crash team comes to them (systems/deterioration.ts).
      case "in_cubicle":
        if (!toiletFromBed(state, p, beingSeen.has(p.id))) goToBed(state, p);
        break;
      case "called_triage":
      case "called_treatment":
      case "triage":
        goToBed(state, p);
        break;
      case "leaving":
        updateLeaving(state, p);
        break;
    }
  }
}

// ---------- Reception ----------

/** Queue spots, by reception room id, are only recomputed when the layout changes. */
const spotCache = new WeakMap<SimState, { version: number; spots: Map<number, Point[]> }>();

function cachedQueueSpots(state: SimState, roomId: number): Point[] {
  let c = spotCache.get(state);
  if (!c || c.version !== state.layoutVersion) {
    c = { version: state.layoutVersion, spots: new Map() };
    spotCache.set(state, c);
  }
  let spots = c.spots.get(roomId);
  if (!spots) {
    spots = queueSpots(state, roomId);
    c.spots.set(roomId, spots);
  }
  return spots;
}

/**
 * First come, first served at each A&E Reception: the head of its queue goes
 * to its next free staffed desk. Patients queue at the reception they're
 * in, or else the nearest one with a receptionist at a desk (any, if none
 * has), so a hospital with two receptions has two queues.
 */
function updateQueue(state: SimState): void {
  const queueing = Object.values(state.patients).filter((p) => p.stage === "queueing");
  if (queueing.length === 0) return;
  const desks = receptionDesks(state);
  const roomOf = (d: PlacedObject) => state.objectRoom[d.id]!;
  const staffed = staffedDesks(state);
  const open = new Set(staffed.map(roomOf));
  const rooms = new Map<number, PlacedObject[]>();
  for (const d of desks) rooms.set(roomOf(d), [...(rooms.get(roomOf(d)) ?? []), d]);
  const queues = new Map<number, Patient[]>();
  for (const p of queueing) {
    const room = receptionFor(state, p, rooms, open);
    if (room === null) {
      stop(p);
      continue;
    }
    queues.set(room, [...(queues.get(room) ?? []), p]);
  }
  for (const [room, queue] of queues) {
    queue.sort((a, b) => a.times.arrived - b.times.arrived || a.id - b.id);
    const freeDesks = staffed.filter(
      (d) => roomOf(d) === room && holder(state, d.id, 0) === undefined,
    );
    while (freeDesks.length > 0 && queue.length > 0) {
      const desk = freeDesks.shift()!;
      const p = queue.shift()!;
      p.stage = "booking";
      p.desk = desk.id;
      p.bookingLeft = ticksFor(state.rng, BOOKING_MINS);
      reserve(state, desk.id, 0, p.id);
    }
    const spots = cachedQueueSpots(state, room);
    queue.forEach((p, n) => {
      // Still walking in: keep heading for the spot they set off for, and
      // take their place in the line on reaching the room, rather than
      // re-plan the whole walk each time the queue moves up.
      if (
        p.path.length > 0 &&
        p.dest &&
        roomAt(state, p.floor, Math.round(p.x), Math.round(p.y))?.id !== room
      ) {
        return;
      }
      const spot = spots[Math.min(n, spots.length - 1)];
      if (spot) headTo(state, p, spot);
      else stop(p);
    });
  }
}

/** The reception room a queueing patient lines up in, or null if there's no desk. */
function receptionFor(
  state: SimState,
  p: Patient,
  rooms: Map<number, PlacedObject[]>,
  open: Set<number>,
): number | null {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const here = roomAt(state, p.floor, x, y);
  const choices = open.size > 0 ? open : new Set(rooms.keys());
  if (here && choices.has(here.id)) return here.id;
  let best: number | null = null;
  let bestD = Infinity;
  for (const room of choices) {
    for (const d of rooms.get(room) ?? []) {
      const dist = Math.abs(d.x - x) + Math.abs(d.y - y);
      if (dist < bestD || (dist === bestD && room < best!)) {
        best = room;
        bestD = dist;
      }
    }
  }
  return best;
}

function updateBooking(state: SimState, p: Patient): void {
  const desk = p.desk === null ? undefined : state.objects[p.desk];
  if (!desk || !inValidRoom(state, desk.id, "ae_reception")) {
    if (p.desk !== null) release(state, p.desk, 0, p.id);
    p.desk = null;
    p.stage = "queueing";
    return;
  }
  if (headTo(state, p, frontOf(desk)) !== "arrived") return;
  // Booking only progresses while the receptionist is at the desk.
  const sid = holder(state, desk.id, "staff");
  const s = sid === undefined ? undefined : state.staff[sid];
  const spot = deskStaffSpot(desk);
  if (!s || s.path.length > 0 || s.floor !== desk.floor || s.x !== spot.x || s.y !== spot.y) {
    return;
  }
  if (--p.bookingLeft > 0) return;
  release(state, desk.id, 0, p.id);
  p.desk = null;
  p.bookingLeft = -1;
  p.times.booked = state.tick;
  p.stage = "waiting_triage";
  postJob(state, {
    kind: "triage",
    roles: ["nurse"],
    patientId: p.id,
    roomType: "triage_room",
    dueTick: p.times.arrived + TRIAGE_TARGET_MINS * TICKS_PER_MINUTE,
    durationTicks: ticksFor(state.rng, TRIAGE_MINS),
  });
}

// ---------- Waiting ----------

function waitInArea(state: SimState, p: Patient, beingSeen: boolean): void {
  if (p.toilet) {
    toiletTrip(state, p);
    return;
  }
  // Staggered so not every patient searches every tick.
  const myTurn = (state.tick + p.id) % 10 === 0;
  if (p.bladder >= TOILET_URGE && myTurn && !beingSeen && goToToilet(state, p)) return;
  if (p.seat) {
    const room = inValidRoom(state, p.seat.objectId, "waiting_area")
      ? roomOfObject(state, p.seat.objectId)
      : undefined;
    if (!room || !mayWaitIn(room, "ae")) releaseSeat(state, p);
  }
  if (!p.seat && (myTurn || p.standing === null)) {
    const seat = freeSeat(state, p, "waiting_area", "ae");
    if (seat) {
      reserve(state, seat.objectId, seat.slot, p.id);
      p.seat = seat;
      p.standing = null;
    }
  }
  if (p.seat) {
    const obj = state.objects[p.seat.objectId]!;
    headTo(state, p, seatTile(obj, p.seat.slot), seatApproach(obj, p.seat.slot));
    return;
  }
  // No free seat: stand in a Waiting Area they may use (or, failing that, reception).
  const grid = state.floors[p.floor]!;
  let spot = p.standing;
  const spotRoom = spot && roomAt(state, spot.floor ?? p.floor, spot.x, spot.y);
  if (
    !spot ||
    !isStandable(grid, spot.x, spot.y) ||
    (spotRoom?.typeId === "waiting_area" && !mayWaitIn(spotRoom, "ae"))
  ) {
    const pickN = (n: number) => nextInt(state.rng, 0, n - 1);
    spot = standingSpot(state, "waiting_area", pickN, "ae") ??
      standingSpot(state, "ae_reception", pickN) ?? {
        x: Math.round(p.x),
        y: Math.round(p.y),
        floor: p.floor,
      };
    p.standing = spot;
  }
  headTo(state, p, spot);
}

/** Off to the nearest free toilet that suits them, if there is one. */
function goToToilet(state: SimState, p: Patient): boolean {
  const toilet = freeToilet(state, p, p.id);
  if (!toilet) return false;
  reserve(state, toilet.id, 0, p.id);
  p.toilet = { objectId: toilet.id, left: -1 };
  toiletTrip(state, p);
  return true;
}

/**
 * A toilet trip: `left` is -1 on the way, the ticks left once there, and 0
 * on the way back to the cubicle or trolley kept for them (from the Waiting
 * Area or the discharge lounge they're done once they leave the toilet).
 */
function toiletTrip(state: SimState, p: Patient): void {
  const trip = p.toilet!;
  if (trip.left === 0) {
    backToBed(state, p);
    return;
  }
  const toilet = state.objects[trip.objectId];
  if (!toilet || !inValidRoom(state, toilet.id, "toilets")) {
    endToiletVisit(state, p);
    return;
  }
  if (trip.left < 0) {
    const arrival = headTo(state, p, { x: toilet.x, y: toilet.y }, frontOf(toilet));
    if (arrival === "arrived") trip.left = ticksFor(state.rng, TOILET_FIXTURES[toilet.defId]!.mins);
    else if (arrival === "no_route") endToiletVisit(state, p);
    return;
  }
  if (--trip.left > 0) return;
  p.bladder = 0;
  const dirt = (state.dirt[toilet.id] ?? 0) + 1;
  state.dirt[toilet.id] = dirt;
  endToiletVisit(state, p);
  if (dirt >= TOILET_USES_BEFORE_CLEAN && !hasCleaningJob(state, toilet.id)) {
    postJob(state, {
      kind: "clean_toilet",
      roles: ["cleaner"],
      objectId: toilet.id,
      roomType: "toilets",
      dueTick: state.tick,
      durationTicks: ticksFor(state.rng, TOILET_FIXTURES[toilet.defId]!.cleanMins),
    });
  }
}

/** Leaves the toilet: back to their bed if one is kept for them, otherwise done. */
function endToiletVisit(state: SimState, p: Patient): void {
  const trip = p.toilet!;
  release(state, trip.objectId, 0, p.id);
  if (keptBed(state, p)) trip.left = 0;
  else p.toilet = null;
}

/** The cubicle or trolley kept for a patient who's left it for the toilet. */
function keptBed(state: SimState, p: Patient): PlacedObject | undefined {
  if (p.stage !== "in_cubicle" && p.stage !== "awaiting_bed") return undefined;
  return p.bed === null ? undefined : state.objects[p.bed];
}

/** Walks back from the toilet; the trip is over once they're on their bed again. */
function backToBed(state: SimState, p: Patient): void {
  const bed = keptBed(state, p);
  if (bed && headTo(state, p, restPoint(bed), bedside(state, bed)) === "moving") return;
  p.toilet = null;
}

/**
 * A patient in a cubicle or on a trolley who needs the toilet, while nobody
 * is seeing them. Most walk there and back, their bed kept for them; one too
 * unwell to leave it (unwellToTravel: Resus, category 1, deteriorating or on
 * continuous monitoring) has a nurse bring a commode instead. True while
 * they're away from their bed.
 */
function toiletFromBed(state: SimState, p: Patient, beingSeen: boolean): boolean {
  if (p.toilet) {
    toiletTrip(state, p);
    return true;
  }
  if (p.bladder < TOILET_URGE || (state.tick + p.id) % 10 !== 0) return false;
  if (!keptBed(state, p) || p.homeBed !== null || p.path.length > 0 || p.death) return false;
  if (withAmbulanceCrew(p) || isEscorted(state, p)) return false;
  if (unwellToTravel(state, p)) {
    if (!jobsForPatient(state, p.id).some((j) => j.kind === "commode")) {
      postJob(state, {
        kind: "commode",
        roles: ["nurse"],
        patientId: p.id,
        roomType: "",
        dueTick: state.tick,
        durationTicks: ticksFor(state.rng, COMMODE_MINS),
      });
    }
    return false;
  }
  // Not while a clinician is with them or on the way.
  if (beingSeen || jobsForPatient(state, p.id).some((j) => j.state !== "open")) return false;
  return goToToilet(state, p);
}

export function releaseSeat(state: SimState, p: Patient): void {
  if (p.seat) release(state, p.seat.objectId, p.seat.slot, p.id);
  p.seat = null;
}

// ---------- Triage and treatment ----------

/** Walk to the reserved couch and lie on it. */
function goToBed(state: SimState, p: Patient): void {
  const bed = p.bed === null ? undefined : state.objects[p.bed];
  if (!bed) return; // The job system notices and sends them back to wait.
  if (isEscorted(state, p)) return; // A porter wheels them (systems/escorts.ts).
  const arrival = withAmbulanceCrew(p)
    ? wheelInFromAmbulance(state, p, bed)
    : headTo(state, p, restPoint(bed), bedside(state, bed));
  if (arrival !== "arrived") return;
  if (p.stage === "called_triage") p.stage = "triage";
  else if (p.stage === "called_treatment") p.stage = "in_cubicle";
}

/**
 * The ambulance crew wheel the patient in on their stretcher to the trolley
 * they're handed over at, by a bed-width route: in by the ambulance
 * entrance (Resus's outside door, say), and otherwise by public routes, not
 * through other clinical rooms if they can help it (see crewAccess).
 */
function wheelInFromAmbulance(state: SimState, p: Patient, bed: PlacedObject): Arrival {
  const to = restPoint(bed);
  const side = bedside(state, bed);
  const from = { x: Math.round(p.x), y: Math.round(p.y), floor: p.floor };
  const planned = p.dest;
  // Already on the way: keep to the stop they set off for.
  const onTheWay =
    planned &&
    planned.x === to.x &&
    planned.y === to.y &&
    planned.blocked < 0 &&
    (planned.ax !== side.x || planned.ay !== side.y);
  // Already squeezing in on foot (no stretcher-width way): carry on, rather
  // than search the whole site for a stretcher route again every tick.
  const squeezing =
    planned &&
    planned.x === to.x &&
    planned.y === to.y &&
    planned.ax === side.x &&
    planned.ay === side.y &&
    p.pathVersion === state.layoutVersion;
  if (squeezing) return headTo(state, p, to, side, false, true);
  const grid = state.floors[p.floor]!;
  // Ruling out stops with no stretcher-width way to them at all first saves
  // searching the whole site for each.
  // The stops are all beside the same trolley, in the same room: if public
  // routes can't reach one, they can't reach the others, so one failed
  // search (which covers the whole site) is enough.
  let publicRouteFailed = false;
  const crewRoute = (at: Point) => {
    if (publicRouteFailed || !bedRouteExists(state, from, at)) return false;
    const ok =
      accessRouteExists(state, p.floor, from, at, "crew", true) &&
      findPath(grid, from.x, from.y, at.x, at.y, {
        bed: true,
        patient: crewAccess(state, p.floor),
      }) !== null;
    if (!ok) publicRouteFailed = true;
    return ok;
  };
  const at = onTheWay
    ? { x: planned.ax, y: planned.ay }
    : (trolleyStop(state, from, bed, crewRoute) ?? trolleyStop(state, from, bed));
  let arrival = at ? headTo(state, p, to, at, true, true) : "no_route";
  if (arrival === "no_route") arrival = squeezeIn(state, p, to, side);
  if (p.dest !== planned) warnIfCutThrough(state, p, from, bed);
  return arrival;
}

/** No stretcher-width route in: they squeeze through on foot with the crew. */
function squeezeIn(state: SimState, p: Patient, to: Point, side: Point): Arrival {
  warn(
    state,
    "no_bed_route_ambulance",
    6 * 60 * TICKS_PER_MINUTE,
    `An ambulance crew couldn't find a stretcher-width route in for ${p.name}. Stretchers need double doors and corridors at least 2 tiles wide.`,
    "warn",
    { x: Math.round(p.x), y: Math.round(p.y), floor: p.floor },
  );
  // Rather than strand them, they squeeze through on foot with the crew.
  return headTo(state, p, to, side, false, true);
}

/** Just set off: the crew had to go through another clinical room to get there. */
function warnIfCutThrough(state: SimState, p: Patient, from: Point, bed: PlacedObject): void {
  const grid = state.floors[p.floor]!;
  const start = grid.roomId[tileIndex(grid, from.x, from.y)]!;
  const end = roomOfObject(state, bed.id);
  const crossed = privateRoomsCrossed(state, p.path, [start, end?.id ?? 0], p.floor);
  const room = state.rooms.find((r) => r.id === crossed[0]);
  if (!room) return;
  const name = (id: string) => roomById.get(id)?.name ?? "clinical room";
  warn(
    state,
    "ambulance_through_clinical_room",
    6 * 60 * TICKS_PER_MINUTE,
    `The ambulance crew had to wheel ${p.name} through the ${name(room.typeId)} to reach the ${name(end?.typeId ?? "")}. Give ambulances a way in that doesn't pass through other clinical rooms.`,
    "warn",
    from,
  );
}

/**
 * Called by a clinician (job system): leave the waiting area for the couch.
 * `keep`: they're off for a scan and keep their current trolley (homeBed).
 */
export function callToBed(state: SimState, p: Patient, bedId: number, keep = false): void {
  releaseSeat(state, p);
  p.standing = null;
  if (keep && p.bed !== null) {
    p.homeBed = p.bed;
    p.bed = null;
  }
  // Moving on from another trolley (say Resus to Majors): that one needs cleaning.
  if (p.bed !== null) {
    release(state, p.bed, 0, p.id);
    dirtyCouch(state, p.bed);
  }
  reserve(state, bedId, 0, p.id);
  p.bed = bedId;
  p.stage = p.stage === "waiting_triage" ? "called_triage" : "called_treatment";
}

/** Back to the waiting area, e.g. when their cubicle was dismantled. */
export function backToWaiting(state: SimState, p: Patient): void {
  if (p.homeBed !== null) {
    leaveScanner(state, p); // Back to the trolley they kept.
    return;
  }
  if (p.bed !== null) release(state, p.bed, 0, p.id);
  p.bed = null;
  if (p.category === 0) {
    // Not handed over yet: stay with the crew where they are.
    p.stage = p.ambulanceId !== null ? "awaiting_handover" : "waiting_triage";
  } else p.stage = "waiting_treatment";
}

/** Posts the job for the patient's current pathway step. */
export function postTreatment(state: SimState, p: Patient, objectId: number | null): void {
  const condition = conditionById.get(p.conditionId)!;
  const step = condition.pathway[p.step]!;
  const target = TRIAGE_CATEGORIES[p.category]?.targetMins ?? 240;
  const escalated = p.deterioration !== null && p.deterioration.noticed !== null;
  // A referral step goes to the specialty's team, if the hospital has one.
  const team = step.specialty !== undefined && hasTeam(state, step.specialty);
  // Getting worse and already brought round to Resus: treated where they lie.
  const resus = escalated && objectId === null ? resusTrolleyFor(state, p, step) : null;
  postJob(state, {
    kind: "treat",
    roles: team ? ["registrar", "consultant"] : step.roles,
    specialty: team ? step.specialty! : null,
    patientId: p.id,
    objectId: resus ?? objectId,
    roomType: resus !== null ? "resus_bay" : step.room,
    capabilities: step.capabilities,
    step: p.step,
    dueTick: escalated ? ESCALATED_DUE : p.times.arrived + target * TICKS_PER_MINUTE,
    durationTicks: ticksFor(state.rng, step.mins),
  });
}

/** Their Resus trolley, if they're on one and a Majors step can be done there. */
function resusTrolleyFor(
  state: SimState,
  p: Patient,
  step: { room: string; capabilities: readonly string[] },
): number | null {
  if (step.room !== "majors_bay" || p.bed === null) return null;
  const room = roomOfObject(state, p.bed);
  if (room?.typeId !== "resus_bay" || !room.valid) return null;
  return step.capabilities.every((c) => room.capabilities.includes(c)) ? p.bed : null;
}

export function afterTriage(state: SimState, p: Patient): void {
  const condition = conditionById.get(p.conditionId)!;
  p.category = condition.acuity;
  p.times.triaged = state.tick;
  const stats = state.today.stats;
  stats.triaged++;
  stats.triageWaitMins += (state.tick - p.times.arrived) / TICKS_PER_MINUTE;
  if (p.bed !== null) release(state, p.bed, 0, p.id);
  p.bed = null;
  p.step = 0;
  p.stage = "waiting_treatment";
  lift(p, MOOD_LIFT_TRIAGED);
  postTreatment(state, p, null);
}

// ---------- Needs and mood ----------

/** Rooms people wait in, so crowding there can be counted. */
const WAITING_ROOMS = new Set(["waiting_area", "ae_reception"]);

const crowdCache = new WeakMap<SimState, { tick: number; byRoom: Map<number, number> }>();

/**
 * How many people are waiting in each Waiting Area (and A&E Reception) right
 * now, by room id: A&E patients waiting to be called and outpatients
 * waiting for their clinic. Counted once a tick.
 */
export function waitingCrowd(state: SimState): Map<number, number> {
  const c = crowdCache.get(state);
  if (c && c.tick === state.tick) return c.byRoom;
  const byRoom = new Map<number, number>();
  const count = (a: Point) => {
    const room = roomAt(state, a.floor ?? 0, Math.round(a.x), Math.round(a.y));
    if (room && WAITING_ROOMS.has(room.typeId)) byRoom.set(room.id, (byRoom.get(room.id) ?? 0) + 1);
  };
  for (const p of Object.values(state.patients)) {
    if ((p.stage === "waiting_triage" || p.stage === "waiting_treatment") && !p.toilet) count(p);
  }
  for (const o of Object.values(state.outpatients)) if (o.stage === "waiting") count(o);
  crowdCache.set(state, { tick: state.tick, byRoom });
  return byRoom;
}

/** People waiting in the room this patient is in, if it's somewhere people wait. */
export function crowdAround(state: SimState, p: Patient): number {
  const room = roomAt(state, p.floor, Math.round(p.x), Math.round(p.y));
  return room ? (waitingCrowd(state).get(room.id) ?? 0) : 0;
}

/** Extra mood lost an hour by an A&E patient waiting in a crowd of `n`. */
export function crowdMoodDecay(n: number, standing: boolean): number {
  const extra = Math.max(0, n - WAITING_CROWD.comfortable) * WAITING_CROWD.perPerson;
  return Math.min(WAITING_CROWD.max, extra) * (standing ? WAITING_CROWD.standingFactor : 1);
}

/** Care has moved on (triaged, seen, a step done, a decision): mood picks up. */
export function lift(p: Patient, amount: number): void {
  p.mood = Math.min(100, p.mood + amount);
}

/**
 * Where an inpatient's mood settles: higher if they've had a visitor in the
 * last day. A visitor with them lifts it; above where it settles, it drifts down.
 */
const WARD_MOOD = { visited: 85, unvisited: 65, withVisitor: 10, drift: 2 };

function updateNeeds(state: SimState, p: Patient, beingSeen: boolean): void {
  if (p.stage === "on_ward" && !p.death) {
    // On an escalation trolley in a corridor, they don't settle.
    if (onEscalationBed(state, p)) {
      p.mood = Math.max(0, p.mood - MOOD_DECAY_IN_CUBICLE / TICKS_PER_HOUR);
      return;
    }
    // Settled in a bed and looked after (ward needs such as meals, toilets
    // and washing are left to the ward team for now). Visitors keep spirits
    // up: without one lately, mood settles lower; with someone there, it lifts.
    // A hot ward without cooling is uncomfortable.
    const settles =
      (visitedLately(state, p) ? WARD_MOOD.visited : WARD_MOOD.unvisited) - heatWardMood(state, p);
    if (hasVisitor(state, p.id)) lift(p, WARD_MOOD.withVisitor / TICKS_PER_HOUR);
    if (p.mood < settles) lift(p, MOOD_RECOVERY_ON_WARD / TICKS_PER_HOUR);
    else p.mood = Math.max(settles, p.mood - WARD_MOOD.drift / TICKS_PER_HOUR);
    return;
  }
  if (p.death || ["leaving", "collapsed", "transferring"].includes(p.stage)) return;
  if (!p.toilet || p.toilet.left <= 0) p.bladder = Math.min(100, p.bladder + p.bladderRate);
  let decay = 0;
  for (const f of moodFactors(state, p, beingSeen)) decay += f.perHour;
  p.mood = Math.min(100, Math.max(0, p.mood - decay / TICKS_PER_HOUR));
}

/** Something wearing a patient's mood down (perHour > 0) or lifting it (< 0). */
export interface MoodFactor {
  label: string;
  /** Mood lost an hour; negative for mood gained. */
  perHour: number;
}

/**
 * What's changing an A&E patient's mood right now, and by how much an hour:
 * updateNeeds sums these, so the inspector can say why they're unhappy.
 * Inpatients settle on the ward instead (see wardMoodFactors).
 */
export function moodFactors(state: SimState, p: Patient, beingSeen: boolean): MoodFactor[] {
  const out: MoodFactor[] = [];
  let decay = 0;
  const add = (label: string, perHour: number) => {
    if (perHour === 0) return;
    out.push({ label, perHour });
    decay += perHour;
  };
  const forTriage = p.stage === "waiting_triage" || p.stage === "called_triage";
  if (p.stage === "awaiting_handover") {
    add("Waiting on the stretcher to be handed over", MOOD_DECAY_SEATED);
  } else if (
    WAITING.has(p.stage) ||
    p.stage === "called_triage" ||
    p.stage === "called_treatment"
  ) {
    const seated = p.seat !== null && p.path.length === 0 && !p.toilet;
    const waitingFor = forTriage ? "Waiting for triage" : "Waiting to be seen";
    if (seated || p.toilet) add(waitingFor, MOOD_DECAY_SEATED);
    else if (p.stage === "queueing") add("Queueing to book in", MOOD_DECAY_STANDING);
    else if (p.seat === null && WAITING.has(p.stage)) {
      add(`${waitingFor}, standing: no free seat`, MOOD_DECAY_STANDING);
    } else add(waitingFor, MOOD_DECAY_STANDING);
    // A packed waiting room is worse, and worse again on your feet.
    if (!p.toilet && WAITING.has(p.stage)) {
      const crowd = crowdAround(state, p);
      add(`Crowded: ${crowd} waiting around them`, crowdMoodDecay(crowd, !seated));
    }
  } else if ((p.stage === "in_cubicle" || p.stage === "awaiting_bed") && !beingSeen) {
    add(
      p.stage === "awaiting_bed"
        ? "Waiting for a ward bed"
        : "Waiting in the cubicle for what's next",
      MOOD_DECAY_IN_CUBICLE,
    );
  }
  if (p.bladder >= 90 && !p.toilet) add("Desperate for the toilet", MOOD_DECAY_TOILET);
  // Waiting in the heat, without cooling (water helps).
  if (decay > 0) add("Too hot: no cooling here", heatMoodDecay(state, p));
  // A clinician with them (triage, treatment, review) reassures them.
  if (beingSeen) add("A clinician is with them", -MOOD_RECOVERY_BEING_SEEN);
  return out;
}

/** What's keeping an inpatient's mood down (or up) on the ward. */
export function wardMoodFactors(state: SimState, p: Patient): MoodFactor[] {
  if (onEscalationBed(state, p)) {
    return [{ label: "On an escalation trolley in a corridor", perHour: MOOD_DECAY_IN_CUBICLE }];
  }
  const out: MoodFactor[] = [];
  if (hasVisitor(state, p.id))
    out.push({ label: "A visitor is with them", perHour: -WARD_MOOD.withVisitor });
  else if (!visitedLately(state, p)) {
    out.push({ label: "No visitor in the last day, so they settle lower", perHour: 0 });
  }
  if (heatWardMood(state, p) > 0) {
    out.push({ label: "The ward is too hot: no cooling", perHour: 0 });
  }
  return out;
}

/**
 * Why a patient who needs the toilet hasn't gone, or null if nothing's in the
 * way (they'll go shortly).
 */
export function toiletHoldUp(state: SimState, p: Patient, beingSeen: boolean): string | null {
  if (p.toilet) return null;
  switch (p.stage) {
    case "waiting_triage":
    case "waiting_treatment":
      return beingSeen ? "they'll go once the clinician is done" : toiletBlocker(state, p.id);
    case "queueing":
    case "booking":
      return "they'll go once they've booked in";
    case "awaiting_handover":
      return "still on the ambulance stretcher, waiting to be handed over";
    case "called_triage":
    case "called_treatment":
      return "on their way to be seen: they'll go once they're settled";
    case "triage":
      return "being triaged: they'll go afterwards";
    case "in_cubicle":
    case "awaiting_bed":
      return bedToiletHoldUp(state, p, beingSeen);
    case "discharge_lounge":
      return toiletBlocker(state, p.id);
    default:
      return null;
  }
}

/** toiletHoldUp for a patient in a cubicle or on a trolley (see toiletFromBed). */
function bedToiletHoldUp(state: SimState, p: Patient, beingSeen: boolean): string | null {
  if (withAmbulanceCrew(p)) return "still with the ambulance crew, waiting to be handed over";
  if (p.homeBed !== null || isEscorted(state, p))
    return "being taken for a scan: they'll go once back";
  if (unwellToTravel(state, p)) {
    const commode = jobsForPatient(state, p.id).find((j) => j.kind === "commode");
    if (commode?.state === "working") return "a nurse is with them with a commode now";
    if (commode?.state === "assigned")
      return "too unwell to walk there: a nurse is bringing a commode";
    return "too unwell to walk there: waiting for a free nurse to bring a commode";
  }
  if (beingSeen) return "they'll go once the clinician is done";
  if (jobsForPatient(state, p.id).some((j) => j.state !== "open")) {
    return "staff are on their way to see them: they'll go afterwards";
  }
  return toiletBlocker(state, p.id);
}

function maybeGiveUp(state: SimState, p: Patient): void {
  if (p.mood >= LWBS_MOOD || state.tick % TICKS_PER_MINUTE !== 0) return;
  const p0 = LWBS_MAX_CHANCE_PER_MIN * (1 - p.mood / LWBS_MOOD);
  if (!chance(state.rng, p0 * (LWBS_ACUITY_FACTOR[p.category] ?? 1))) return;
  const mins = Math.round((state.tick - p.times.arrived) / TICKS_PER_MINUTE);
  emit(state, `${p.name} left without being seen after ${formatWait(mins)}`, "warn", {
    x: Math.round(p.x),
    y: Math.round(p.y),
    floor: p.floor,
  });
  leave(state, p, "lwbs");
}

export function formatWait(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h === 0 ? `${m} min` : `${h}h ${String(m).padStart(2, "0")}m`;
}

// ---------- Leaving ----------

/**
 * Discharged or transferred (with the tariff earned), or gave up: release
 * everything and head out. Inpatients going home from a ward left A&E (and
 * were counted there) when they were admitted; they earn the inpatient tariff.
 */
/**
 * Re-triage down to `category` (a higher number: less urgent), recording it.
 * Never raises priority: escalation is noticing deterioration's job.
 */
export function retriage(state: SimState, p: Patient, category: number): void {
  if (p.category === 0 || category <= p.category) return;
  p.retriaged = { tick: state.tick, from: p.retriaged?.from ?? p.category };
  p.category = category;
}

/** Category of someone well enough to go home: at most Standard. */
const FIT_FOR_DISCHARGE = 4;

export function leave(state: SimState, p: Patient, outcome: Outcome): void {
  // Nobody is sent home while still warranting an urgent category.
  if (outcome === "discharged") retriage(state, p, FIT_FOR_DISCHARGE);
  for (const job of jobsForPatient(state, p.id)) removeJob(state, job);
  releaseSeat(state, p);
  if (p.bed !== null) release(state, p.bed, 0, p.id);
  if (p.desk !== null) release(state, p.desk, 0, p.id);
  if (p.toilet) release(state, p.toilet.objectId, 0, p.id);
  if (p.homeBed !== null) release(state, p.homeBed, 0, p.id);
  p.homeBed = null;
  p.bed = null;
  p.desk = null;
  p.toilet = null;
  p.standing = null;
  p.stage = "leaving";
  p.outcome = outcome;
  p.times.left = state.tick;

  const stats = state.today.stats;
  const condition = conditionById.get(p.conditionId)!;
  if (p.times.admitted !== null) {
    stats.wardDischarges++;
    stats.stayMins += (state.tick - p.times.admitted) / TICKS_PER_MINUTE;
    // A planned inpatient's stay is planned care, paid in full.
    if (condition.planned) {
      earnPlanned(state, condition.admission?.tariff ?? 0, p.elective?.payer ?? "phs", false);
    } else earnEmergency(state, condition.admission?.tariff ?? 0, "wards");
    return;
  }
  if (p.elective) {
    // A day case going home: the day-case tariff. They were never in A&E.
    earnPlanned(state, condition.tariff, p.elective.payer, true);
    return;
  }
  recordDeparture(state, p);
  if (outcome === "lwbs") stats.lwbs++;
  else {
    if (outcome === "transferred") stats.transferred++;
    else if (outcome === "transferred_out") stats.transfersOut++;
    else stats.discharged++;
    earnEmergency(state, condition.tariff, "ae");
  }
}

/** Still in A&E: not on their way out, admitted to a ward, or deceased. */
export function inAE(p: Patient): boolean {
  return (
    p.elective === null &&
    !p.emergencyOp?.done &&
    !SURGICAL_STAGES.has(p.stage) &&
    p.stage !== "leaving" &&
    p.stage !== "on_ward" &&
    p.death === null
  );
}

/** In for surgery, or gone from A&E to theatre (systems/theatres.ts). */
const SURGICAL_STAGES = new Set<Patient["stage"]>([
  "pre_op",
  "to_theatre",
  "in_theatre",
  "in_recovery",
  "post_op",
]);

/** Leaving A&E (home, elsewhere, or died): the 4-hour clock stops. */
export function recordDeparture(state: SimState, p: Patient): void {
  const stats = state.today.stats;
  const mins = (state.tick - p.times.arrived) / TICKS_PER_MINUTE;
  stats.departures++;
  stats.timeInDeptMins += mins;
  if (mins <= FOUR_HOUR_MINS) stats.within4h++;
}

function updateLeaving(state: SimState, p: Patient): void {
  // Taken straight to intensive care (an ICU of your own comes later).
  if (p.outcome === "transferred" || p.outcome === "transferred_out") {
    delete state.patients[p.id];
    return;
  }
  const exit = siteEntrance(state) ?? fallbackEntrance(state);
  const arrival = headTo(state, p, exit);
  // Unreachable exits don't trap anyone: they find their own way out.
  if (arrival === "arrived" || arrival === "no_route") delete state.patients[p.id];
}
