/**
 * A&E arrivals (GAME_DESIGN §5.1). Walk-ins and ambulances turn up at random
 * (Poisson processes) at rates that follow the time of day. Walk-ins come
 * while there's a working A&E reception; ambulances while there's an
 * Ambulance Bay to park in (systems/ambulances.ts does the rest).
 */
import { conditionById, content } from "@data/catalogue";
import type { ConditionDef } from "@data/schema";
import { FIRST_NAMES, SURNAMES } from "@data/names";
import {
  AMBULANCES_BY_HOUR,
  AMBULANCES_PER_100K,
  DEFLECT_AT_QUEUE,
  ARRIVALS_BY_HOUR,
  BLADDER_HOURS,
  START_MOOD,
  UNTREATABLE_WALK_IN_SHARE,
  WALK_IN_BY_BUS,
  WALK_INS_PER_100K,
} from "@data/patients";
import type { Patient, Point } from "../agents";
import { warn } from "../events";
import { arrivalPoints, hasRoomWith, receptionDesks, siteEntrance } from "../places";
import { chance, nextFloat, nextInt, pick } from "../rng";
import type { SimState } from "../state";
import { clockFromTick, TICKS_PER_MINUTE } from "../time";
import {
  ambulanceArrives,
  ambulancesWaiting,
  baySpaces,
  parkingSpaces,
  stretcherSpot,
} from "./ambulances";
import { rollDeterioration } from "./deterioration";
import { arrivalFactor, conditionFactor } from "./pressure";

const TICKS_PER_HOUR = TICKS_PER_MINUTE * 60;
const total = (profile: readonly number[]) => profile.reduce((a, b) => a + b, 0);

/** Expected walk-ins per tick at this time of day, from `perDay` a day. */
export function arrivalRate(tick: number, perDay: number): number {
  const { hour } = clockFromTick(tick);
  return (perDay * ARRIVALS_BY_HOUR[hour]!) / total(ARRIVALS_BY_HOUR) / TICKS_PER_HOUR;
}

/** Expected ambulances per tick at this time of day, from `perDay` a day. */
export function ambulanceRate(tick: number, perDay: number): number {
  const { hour } = clockFromTick(tick);
  return (perDay * AMBULANCES_BY_HOUR[hour]!) / total(AMBULANCES_BY_HOUR) / TICKS_PER_HOUR;
}

/**
 * Walk-ins and ambulances a day for the hospital's catchment, before
 * capability sharing (see treatableShare).
 */
export function dailyDemand(state: SimState): { walkIns: number; ambulances: number } {
  const people = (state.settings.catchment / 100_000) * state.settings.patientVolume;
  return { walkIns: WALK_INS_PER_100K * people, ambulances: AMBULANCES_PER_100K * people };
}

const shareCache = new WeakMap<SimState, { version: number; walk_in: number; ambulance: number }>();

/**
 * How likely a patient with this condition is to come here by this channel:
 * 1 if the hospital can treat it; otherwise ambulance control takes them
 * elsewhere, and only some walk-ins turn up anyway (to be transferred out).
 */
function arrivalWeight(c: ConditionDef, ch: "walk_in" | "ambulance", treatable: boolean): number {
  if (treatable) return c.channels[ch];
  return ch === "walk_in" ? c.channels[ch] * UNTREATABLE_WALK_IN_SHARE : 0;
}

/**
 * The share of the catchment's patients who come here: those with a
 * condition the hospital can treat, weighted by how often each arrives by
 * this channel, plus some walk-ins it can't (see arrivalWeight). The rest go
 * to a neighbouring hospital. Cached per layout.
 */
export function treatableShare(state: SimState, channel: "walk_in" | "ambulance"): number {
  let cached = shareCache.get(state);
  if (!cached || cached.version !== state.layoutVersion) {
    const treatable = new Set(treatableConditions(state));
    const share = (ch: "walk_in" | "ambulance") => {
      let all = 0;
      let here = 0;
      for (const c of content.conditions) {
        all += c.channels[ch];
        here += arrivalWeight(c, ch, treatable.has(c));
      }
      return all > 0 ? here / all : 0;
    };
    cached = {
      version: state.layoutVersion,
      walk_in: share("walk_in"),
      ambulance: share("ambulance"),
    };
    shareCache.set(state, cached);
  }
  return cached[channel];
}

export function updateArrivals(state: SimState): void {
  // A Private Hospital has no emergency department: 999 calls and walk-ins go to the NHS.
  if (state.funding === "private") return;
  const demand = dailyDemand(state);
  // Always draw both, so the random sequence doesn't depend on the layout.
  // Pressure events (winter, heat) bring more.
  const ambulance = chance(
    state.rng,
    ambulanceRate(state.tick, demand.ambulances) *
      treatableShare(state, "ambulance") *
      arrivalFactor(state, "ambulance"),
  );
  const walkIn = chance(
    state.rng,
    arrivalRate(state.tick, demand.walkIns) *
      treatableShare(state, "walk_in") *
      arrivalFactor(state, "walk_in"),
  );
  const ae = state.departments.ae;
  if (ae === "closed") return; // Closed: patients go elsewhere.
  if (ambulance) {
    if (ae === "divert") state.today.stats.diverted++;
    else ambulanceComes(state);
  }
  if (walkIn) walkInArrives(state);
}

/**
 * A 999 call for a patient this hospital can treat. Ambulances only come to
 * a hospital with somewhere they can park, and ambulance control sends them
 * elsewhere when crews are already queueing outside.
 */
function ambulanceComes(state: SimState, conditionId: string | null = null): boolean {
  if (parkingSpaces(state).length === 0) {
    if (baySpaces(state).length > 0) {
      warn(
        state,
        "ambulance_no_road",
        TICKS_PER_HOUR * 6,
        "An ambulance went to another hospital: it couldn't drive to your Ambulance Bay. Link the bay to the road with an access road at least 3 tiles wide.",
        "bad",
        stretcherSpot(baySpaces(state)[0]!),
      );
    }
    return false;
  }
  const queueing = ambulancesWaiting(state);
  if (queueing >= DEFLECT_AT_QUEUE) {
    state.today.stats.deflected++;
    warn(
      state,
      "ambulance_deflected",
      TICKS_PER_HOUR * 2,
      `Ambulance control is sending ambulances to other hospitals: ${queueing} crews are already queueing outside here. Free up Majors and Resus, or add Ambulance Bay spaces.`,
    );
    return false;
  }
  ambulanceArrives(state, conditionId);
  return true;
}

function walkInArrives(state: SimState, conditionId?: string): boolean {
  if (receptionDesks(state).length === 0) return false; // No A&E open, so no one comes.
  const entrance = siteEntrance(state);
  if (!entrance) {
    warn(
      state,
      "no_entrance",
      TICKS_PER_HOUR * 6,
      "Patients can't reach A&E reception: there's no way in from outside. Add an outside door.",
      "bad",
    );
    return false;
  }
  spawnPatient(state, walkInPoint(state) ?? entrance, conditionId);
  return true;
}

/**
 * A major incident casualty by ambulance (systems/majorIncident.ts). With
 * A&E closed or on divert, or nowhere to park, ambulance control takes them
 * elsewhere. Returns whether they came here.
 */
export function casualtyAmbulance(state: SimState, conditionId: string): boolean {
  if (state.funding === "private" || state.departments.ae !== "open") return false;
  return ambulanceComes(state, conditionId);
}

/** Walking wounded from a major incident, making their own way to A&E. */
export function casualtyWalksIn(state: SimState, conditionId: string): boolean {
  if (state.funding === "private" || state.departments.ae === "closed") return false;
  return walkInArrives(state, conditionId);
}

/**
 * Where a walk-in turns up on a map with a public road: off the bus, or along
 * the pavement from either end (on foot, or dropped off or parked nearby).
 */
export function walkInPoint(state: SimState): Point | null {
  const [west, east, busStop] = arrivalPoints(state);
  if (!west || !east || !busStop) return null;
  const r = nextFloat(state.rng);
  if (r < WALK_IN_BY_BUS) return busStop;
  return r < WALK_IN_BY_BUS + (1 - WALK_IN_BY_BUS) / 2 ? west : east;
}

/**
 * Conditions the hospital can treat: every room type on the pathway has a
 * working room, and there's a Pathology Lab if they need blood tests.
 * (Whether it can admit them is another matter: see systems/transfers.ts.)
 */
export function treatableConditions(state: SimState): ConditionDef[] {
  const lab = hasRoomWith(state, "lab", ["pathology"]);
  return content.conditions.filter(
    (c) =>
      !c.planned &&
      c.pathway.every((s) => hasRoomWith(state, s.room, s.capabilities) && (lab || !s.sample)),
  );
}

/** A new patient at `at`: a walk-in queueing for reception, or on an ambulance stretcher. */
export function spawnPatient(
  state: SimState,
  at: { x: number; y: number },
  conditionId?: string,
  channel: "walk_in" | "ambulance" = "walk_in",
): Patient {
  const rng = state.rng;
  const treatable = new Set(treatableConditions(state));
  let options = content.conditions.filter((c) => arrivalWeight(c, channel, treatable.has(c)) > 0);
  // Pressure events shift the mix (more breathing problems in a flu season).
  let weights = options.map(
    (c) => arrivalWeight(c, channel, treatable.has(c)) * conditionFactor(state, c.id),
  );
  if (options.length === 0) {
    options = content.conditions.filter((c) => c.channels[channel] > 0);
    weights = options.map((c) => c.channels[channel]);
  }
  let r = nextFloat(rng) * weights.reduce((a, b) => a + b, 0);
  let condition = options[0]!;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) {
      condition = options[i]!;
      break;
    }
  }
  if (conditionId !== undefined) condition = conditionById.get(conditionId)!;
  const patient = newPatient(
    state,
    at,
    condition,
    channel === "ambulance" ? "awaiting_handover" : "queueing",
  );
  rollDeterioration(state, patient);
  state.patients[patient.id] = patient;
  state.today.stats.arrivals++;
  return patient;
}

/** A patient record at `at`, not yet in the hospital (the caller adds them). */
export function newPatient(
  state: SimState,
  at: { x: number; y: number },
  condition: ConditionDef,
  stage: Patient["stage"],
): Patient {
  const rng = state.rng;
  const hours = BLADDER_HOURS * (0.7 + 0.6 * nextFloat(rng));
  const patient: Patient = {
    id: state.nextAgentId++,
    name: `${pick(rng, FIRST_NAMES)} ${pick(rng, SURNAMES)}`,
    x: at.x,
    y: at.y,
    prevX: at.x,
    prevY: at.y,
    lastVisit: null,
    path: [],
    dest: null,
    pathVersion: state.layoutVersion,
    conditionId: condition.id,
    category: 0,
    retriaged: null,
    stage,
    step: 0,
    seat: null,
    standing: null,
    bed: null,
    desk: null,
    bookingLeft: -1,
    toilet: null,
    ambulanceId: null,
    deterioration: null,
    obs: null,
    mood: nextInt(rng, START_MOOD[0], START_MOOD[1]),
    bladder: nextInt(rng, 0, 50),
    bladderRate: 100 / (hours * TICKS_PER_HOUR),
    times: {
      arrived: state.tick,
      booked: null,
      triaged: null,
      seen: null,
      referred: null,
      decided: null,
      admitted: null,
      left: null,
    },
    consultants: [],
    specialty: null,
    stayUntil: null,
    endOfLife: false,
    curtainUntil: null,
    transfer: null,
    investigations: [],
    homeBed: null,
    elective: null,
    emergencyOp: null,
    death: null,
    outcome: null,
  };
  return patient;
}
