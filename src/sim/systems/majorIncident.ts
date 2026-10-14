/**
 * Major incidents (GAME_DESIGN §9), as the NHS runs them. The ambulance
 * service puts the hospital on standby, then sends a wave of casualties
 * over a few hours: critically injured (P1) for Resus, seriously injured
 * (P2) for Majors, and walking wounded (P3) who make their own way in. The
 * player decides whether to declare their own major incident and run the
 * hospital's plan: call in off-duty staff (paid overtime, arriving over the
 * next hour or so), stand down clinics and planned operations, open
 * escalation beds and review every ward patient due home within a day.
 * They stand down once A&E has recovered (or it happens on its own, well
 * after the last casualty): called-in staff go home and planned care
 * resumes. Not declaring saves the disruption, and the overtime, at the
 * risk of being swamped.
 */
import { MAJOR_INCIDENT } from "@data/pressure";
import type { Staff } from "../agents";
import { emit } from "../events";
import { nextFloat, nextInt, pick } from "../rng";
import type { MajorIncident, PressureEvent, SimState } from "../state";
import { clockFromTick, TICKS_PER_MINUTE } from "../time";
import { casualtyAmbulance, casualtyWalksIn } from "./arrivals";
import { bookAppointments } from "./referrals";
import { callIn } from "./rota";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;

/** Sets up a major incident's casualties when it's forecast. */
export function planIncident(state: SimState, e: PressureEvent): MajorIncident {
  const n = nextInt(state.rng, MAJOR_INCIDENT.casualties[0], MAJOR_INCIDENT.casualties[1]);
  const window = e.end - e.start;
  const casualties: MajorIncident["casualties"] = [];
  for (let i = 0; i < n; i++) {
    const r = nextFloat(state.rng);
    if (r < MAJOR_INCIDENT.p1Share + MAJOR_INCIDENT.p2Share) {
      casualties.push({
        at: e.start + Math.floor(nextFloat(state.rng) * window),
        conditionId: r < MAJOR_INCIDENT.p1Share ? "major_trauma" : "serious_injury",
        channel: "ambulance",
      });
    } else {
      // The walking wounded trickle in over a little longer, by car, taxi or on foot.
      casualties.push({
        at: e.start + Math.floor((0.25 + nextFloat(state.rng)) * window),
        conditionId: pick(state.rng, MAJOR_INCIDENT.walkingWounded),
        channel: "walk_in",
      });
    }
  }
  casualties.sort((a, b) => a.at - b.at);
  const incident: MajorIncident = {
    eventId: e.id,
    cause: pick(state.rng, MAJOR_INCIDENT.causes),
    expected: n,
    arrived: 0,
    casualties,
    declared: null,
    previous: null,
    asked: 0,
    coming: [],
    calledIn: [],
    last: null,
  };
  state.pressure.majorIncident = incident;
  return incident;
}

/** The standby message, when the ambulance service alerts the hospital. */
export function standbyText(state: SimState, e: PressureEvent): string {
  const mi = state.pressure.majorIncident;
  const p1 = mi?.casualties.filter((c) => c.conditionId === "major_trauma").length ?? 0;
  return (
    `Major incident – standby: ${mi?.cause ?? "a major incident"}. About ${mi?.expected ?? "several"} casualties ` +
    `(${p1} critical) are expected from ${hhmm(e.start)}. ` +
    "Declare a major incident to call in staff and clear the department (Hospital → Events)."
  );
}

function hhmm(tick: number): string {
  const c = clockFromTick(tick);
  return `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
}

export function majorIncidentDeclared(state: SimState): boolean {
  return state.pressure.majorIncident?.declared != null;
}

/** Called in for the major incident: they stay at work until it's stood down. */
export function isCalledIn(state: SimState, s: Staff): boolean {
  return state.pressure.majorIncident?.calledIn.includes(s.id) ?? false;
}

/** Each tick: casualties arrive, called-in staff turn up, and in time it's stood down. */
export function updateMajorIncident(state: SimState): void {
  const mi = state.pressure.majorIncident;
  if (!mi) return;
  while (mi.casualties.length > 0 && mi.casualties[0]!.at <= state.tick) {
    const c = mi.casualties.shift()!;
    const came =
      c.channel === "ambulance"
        ? casualtyAmbulance(state, c.conditionId)
        : casualtyWalksIn(state, c.conditionId);
    if (came) mi.arrived++;
    mi.last = state.tick;
  }
  for (const c of mi.coming.filter((c) => c.at <= state.tick)) {
    mi.coming = mi.coming.filter((x) => x !== c);
    const s = state.staff[c.staffId];
    if (!s) continue;
    callIn(state, s);
    mi.calledIn.push(s.id);
  }
  if (mi.casualties.length > 0) return;
  const after = state.tick - (mi.last ?? state.tick);
  if (mi.declared === null) {
    // Never declared: once the last casualty is in, it's over.
    if (state.pressure.active.every((e) => e.id !== mi.eventId))
      state.pressure.majorIncident = null;
  } else if (after >= MAJOR_INCIDENT.autoStandDownHours * TICKS_PER_HOUR) {
    standDown(state, true);
  }
}

/**
 * Declares a major incident: off-duty staff are called in, clinics and
 * planned operations stand down, escalation beds open, and ward patients
 * due home soon are reviewed now. Returns false if there's nothing to declare.
 */
export function declare(state: SimState): boolean {
  const mi = state.pressure.majorIncident;
  if (!mi || mi.declared !== null) return false;
  mi.declared = state.tick;
  const d = state.departments;
  mi.previous = {
    outpatients: d.outpatients,
    theatres: d.theatres,
    escalation: state.policies.escalation,
  };
  if (d.theatres === "open") d.theatres = "emergency";
  d.outpatients = "closed";
  state.policies.escalation = true;
  bookAppointments(state);
  for (const s of Object.values(state.staff)) {
    if (s.contract !== "resident" || s.duty !== "off" || s.onCall) continue;
    if (s.sickUntil !== null && state.tick < s.sickUntil) continue;
    if (s.leavesAt !== null) continue;
    mi.asked++;
    if (nextFloat(state.rng) >= MAJOR_INCIDENT.respondChance) continue;
    const mins = nextInt(state.rng, MAJOR_INCIDENT.arriveMins[0], MAJOR_INCIDENT.arriveMins[1]);
    mi.coming.push({ staffId: s.id, at: state.tick + mins * TICKS_PER_MINUTE });
  }
  emit(
    state,
    `Major incident declared. ${mi.asked === 0 ? "Nobody is off duty to call in" : `${mi.coming.length} of ${mi.asked} off-duty staff are coming in`}; clinics and planned operations are stood down, escalation beds are open, and ward patients due home within a day are being reviewed.`,
    "bad",
    undefined,
    undefined,
    undefined,
    "events",
  );
  return true;
}

/** Stands the major incident down: called-in staff go home, and planned care resumes. */
export function standDown(state: SimState, automatic = false): boolean {
  const mi = state.pressure.majorIncident;
  if (!mi || mi.declared === null) return false;
  const d = state.departments;
  if (mi.previous) {
    if (d.theatres === "emergency") d.theatres = mi.previous.theatres;
    if (d.outpatients === "closed") d.outpatients = mi.previous.outpatients;
    state.policies.escalation = mi.previous.escalation;
  }
  bookAppointments(state);
  const home = mi.calledIn.length;
  // Anyone still on their way is told not to come; the rota sends the rest home.
  state.pressure.majorIncident = null;
  emit(
    state,
    `Major incident stood down${automatic ? " (12 hours after the last casualty)" : ""}. ${home} called-in staff go home; clinics and planned operations resume.`,
    "info",
    undefined,
    undefined,
    undefined,
    "events",
  );
  return true;
}
