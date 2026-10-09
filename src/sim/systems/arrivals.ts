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
  const demand = dailyDemand(state);
  // Always draw both, so the random sequence doesn't depend on the layout.
  const ambulance = chance(
    state.rng,
    ambulanceRate(state.tick, demand.ambulances) * treatableShare(state, "ambulance"),
  );
  const walkIn = chance(
    state.rng,
    arrivalRate(state.tick, demand.walkIns) * treatableShare(state, "walk_in"),
  );
  if (ambulance) ambulanceComes(state);
  if (walkIn) walkInArrives(state);
}

/**
 * A 999 call for a patient this hospital can treat. Ambulances only come to
 * a hospital with somewhere they can park, and ambulance control sends them
 * elsewhere when crews are already queueing outside.
 */
function ambulanceComes(state: SimState): void {
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
    return;
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
    return;
  }
  ambulanceArrives(state);
}

function walkInArrives(state: SimState): void {
  if (receptionDesks(state).length === 0) return; // No A&E open, so no one comes.
  const entrance = siteEntrance(state);
  if (!entrance) {
    warn(
      state,
      "no_entrance",
      TICKS_PER_HOUR * 6,
      "Patients can't reach A&E reception: there's no way in from outside. Add an outside door.",
      "bad",
    );
    return;
  }
  spawnPatient(state, walkInPoint(state) ?? entrance);
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
  return content.conditions.filter((c) =>
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
  let weights = options.map((c) => arrivalWeight(c, channel, treatable.has(c)));
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
  const hours = BLADDER_HOURS * (0.7 + 0.6 * nextFloat(rng));
  const patient: Patient = {
    id: state.nextAgentId++,
    name: `${pick(rng, FIRST_NAMES)} ${pick(rng, SURNAMES)}`,
    x: at.x,
    y: at.y,
    prevX: at.x,
    prevY: at.y,
    path: [],
    dest: null,
    pathVersion: state.layoutVersion,
    conditionId: condition.id,
    category: 0,
    retriaged: null,
    stage: channel === "ambulance" ? "awaiting_handover" : "queueing",
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
    death: null,
    outcome: null,
  };
  rollDeterioration(state, patient);
  state.patients[patient.id] = patient;
  state.today.stats.arrivals++;
  return patient;
}
