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
  AMBULANCES_PER_DAY,
  ARRIVALS_BY_HOUR,
  BLADDER_HOURS,
  START_MOOD,
  WALK_IN_BY_BUS,
  WALK_INS_PER_DAY,
} from "@data/patients";
import type { Patient, Point } from "../agents";
import { warn } from "../events";
import { arrivalPoints, receptionDesks, siteEntrance } from "../places";
import { chance, nextFloat, nextInt, pick } from "../rng";
import type { SimState } from "../state";
import { clockFromTick, TICKS_PER_MINUTE } from "../time";
import { ambulanceArrives, baySpaces, parkingSpaces, stretcherSpot } from "./ambulances";
import { rollDeterioration } from "./deterioration";

const TICKS_PER_HOUR = TICKS_PER_MINUTE * 60;
const total = (profile: readonly number[]) => profile.reduce((a, b) => a + b, 0);

/** Expected walk-ins per tick at this time of day. */
export function arrivalRate(tick: number, perDay = WALK_INS_PER_DAY): number {
  const { hour } = clockFromTick(tick);
  return (perDay * ARRIVALS_BY_HOUR[hour]!) / total(ARRIVALS_BY_HOUR) / TICKS_PER_HOUR;
}

/** Expected ambulances per tick at this time of day. */
export function ambulanceRate(tick: number, perDay = AMBULANCES_PER_DAY): number {
  const { hour } = clockFromTick(tick);
  return (perDay * AMBULANCES_BY_HOUR[hour]!) / total(AMBULANCES_BY_HOUR) / TICKS_PER_HOUR;
}

export function updateArrivals(state: SimState): void {
  // Always draw both, so the random sequence doesn't depend on the layout.
  const volume = state.settings.patientVolume;
  const ambulance = chance(state.rng, ambulanceRate(state.tick) * volume);
  const walkIn = chance(state.rng, arrivalRate(state.tick) * volume);
  // Ambulances only come to a hospital with somewhere to park them.
  if (ambulance && parkingSpaces(state).length > 0) ambulanceArrives(state);
  else if (ambulance && baySpaces(state).length > 0) {
    warn(
      state,
      "ambulance_no_road",
      TICKS_PER_HOUR * 6,
      "An ambulance went to another hospital: it couldn't drive to your Ambulance Bay. Link the bay to the road with an access road at least 3 tiles wide.",
      "bad",
      stretcherSpot(baySpaces(state)[0]!),
    );
  }
  if (walkIn) walkInArrives(state);
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
 * working room. Interim: once A&E can stabilise and transfer patients out
 * (M4), anyone will turn up regardless.
 */
export function treatableConditions(state: SimState): ConditionDef[] {
  const rooms = new Set(state.rooms.filter((r) => r.valid).map((r) => r.typeId));
  return content.conditions.filter((c) => c.pathway.every((s) => rooms.has(s.room)));
}

/** A new patient at `at`: a walk-in queueing for reception, or on an ambulance stretcher. */
export function spawnPatient(
  state: SimState,
  at: { x: number; y: number },
  conditionId?: string,
  channel: "walk_in" | "ambulance" = "walk_in",
): Patient {
  const rng = state.rng;
  let options = treatableConditions(state).filter((c) => c.channels[channel] > 0);
  if (options.length === 0) options = content.conditions.filter((c) => c.channels[channel] > 0);
  const weights = options.map((c) => c.channels[channel]);
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
      decided: null,
      admitted: null,
      left: null,
    },
    stayUntil: null,
    endOfLife: false,
    death: null,
    outcome: null,
  };
  rollDeterioration(state, patient);
  state.patients[patient.id] = patient;
  state.today.stats.arrivals++;
  return patient;
}
