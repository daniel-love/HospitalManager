/**
 * Pressure events (GAME_DESIGN §9): winter pressures, heatwaves and (later)
 * major incidents, outbreaks and the rest. Each is forecast before it
 * starts (flu surveillance, a heat-health alert), runs for a while at an
 * intensity that may build and fade, and then ends. While it runs it shifts
 * demand and the condition mix (systems/arrivals.ts), staff sickness
 * (systems/workforce.ts) and, in the heat, patients' mood and staff fatigue
 * in rooms without cooling. The levers are the hospital's own: escalation,
 * department statuses, staffing, cooling, flu vaccination.
 *
 * In sandbox, events follow a realistic calendar (data/pressure.ts): each
 * kind can only start in its months, at about its real-world rate scaled by
 * the event-frequency setting. A setting of off never draws on the random
 * stream, so test fixtures are unaffected.
 */
import { equipmentById } from "@data/catalogue";
import {
  EVENT_FREQUENCY,
  FLU_VACCINATION,
  HEAT,
  PRESSURE_EVENTS,
  pressureEventById,
  type PressureEventDef,
} from "@data/pressure";
import { onSite, type Patient, type Point, type Staff } from "../agents";
import { emit } from "../events";
import { chance, nextInt } from "../rng";
import type { PressureEvent, Room, SimState } from "../state";
import {
  clockFromTick,
  dateOf,
  formatDate,
  MINUTES_PER_DAY,
  MONTHS,
  START_MINUTE_OF_DAY,
  tickAt,
  TICKS_PER_DAY,
  TICKS_PER_MINUTE,
} from "../time";
import { roomAt } from "../world/rooms";
import { book } from "./serviceLines";
import { bookAppointments } from "./referrals";
import { majorIncidentDeclared, planIncident, standbyText } from "./majorIncident";

/** Events start at 08:00 on their first day. */
const START_HOUR = 8;

/** How strong an event is now, 0 to 1: nothing before it starts. */
export function intensity(state: SimState, e: PressureEvent): number {
  if (state.tick < e.start || state.tick >= e.end) return 0;
  const def = pressureEventById.get(e.defId)!;
  if (def.shape === "flat") return 1;
  // A wave: builds, peaks halfway, and fades.
  const t = (state.tick - e.start) / (e.end - e.start);
  return Math.sin(Math.PI * t);
}

/** Events under way now (not just forecast). */
export function eventsUnderWay(state: SimState): PressureEvent[] {
  return state.pressure.active.filter((e) => state.tick >= e.start && state.tick < e.end);
}

/** Scales a multiplier `m` by intensity `i`: 1 at none, m at full. */
const scaled = (m: number, i: number) => 1 + (m - 1) * i;

/** The multiplier on walk-ins or ambulances from events under way. */
export function arrivalFactor(state: SimState, channel: "walk_in" | "ambulance"): number {
  let f = 1;
  for (const e of state.pressure.active) {
    const i = intensity(state, e);
    if (i > 0) f *= scaled(pressureEventById.get(e.defId)!.arrivals[channel], i);
  }
  return f;
}

/** The multiplier on a condition's share of arrivals from events under way. */
export function conditionFactor(state: SimState, conditionId: string): number {
  let f = 1;
  for (const e of state.pressure.active) {
    const i = intensity(state, e);
    const m = pressureEventById.get(e.defId)!.conditions[conditionId];
    if (i > 0 && m !== undefined) f *= scaled(m, i);
  }
  return f;
}

/** The financial year now (0 = Year 1, April to March). */
const yearNow = (state: SimState) =>
  Math.floor(dateOf(clockFromTick(state.tick).day).monthIndex / 12);

/** The multiplier on the chance of calling in sick, less what flu vaccination prevents. */
export function sicknessFactor(state: SimState): number {
  const protection = state.pressure.vaccinated === yearNow(state) ? FLU_VACCINATION.protection : 0;
  let f = 1;
  for (const e of state.pressure.active) {
    const i = intensity(state, e);
    const m = pressureEventById.get(e.defId)!.sickness;
    if (i > 0 && m > 1) f *= scaled(m, i * (1 - protection));
  }
  return f;
}

/** How hot it is, 0 to 1: the strongest heat event under way. */
export function heat(state: SimState): number {
  let h = 0;
  for (const e of state.pressure.active) {
    if (pressureEventById.get(e.defId)!.heat) h = Math.max(h, intensity(state, e));
  }
  return h;
}

const coolCache = new WeakMap<SimState, { version: number; cool: Set<number> }>();

/** Whether a room has enough cooling for its size (HEAT.tilesPerCooler a unit). */
export function isCooled(state: SimState, room: Room): boolean {
  let cached = coolCache.get(state);
  if (!cached || cached.version !== state.layoutVersion) {
    const cool = new Set<number>();
    for (const r of state.rooms) {
      const units = r.objectIds.filter((id) =>
        equipmentById.get(state.objects[id]?.defId ?? "")?.capabilities.includes("cooling"),
      ).length;
      if (units > 0 && units * HEAT.tilesPerCooler >= r.tiles.length) cool.add(r.id);
    }
    cached = { version: state.layoutVersion, cool };
    coolCache.set(state, cached);
  }
  return cached.cool.has(room.id);
}

/** How hot it is where an agent is: 0 in a cooled room or when there's no heat. */
export function heatAt(state: SimState, at: Point): number {
  const h = heat(state);
  if (h === 0) return 0;
  const room = roomAt(state, at.floor ?? 0, Math.round(at.x), Math.round(at.y));
  return room && isCooled(state, room) ? 0 : h;
}

/** Extra mood lost an hour by a patient waiting or in a cubicle in the heat. */
export function heatMoodDecay(state: SimState, p: Patient): number {
  const h = heatAt(state, p);
  if (h === 0) return 0;
  const room = roomAt(state, p.floor, Math.round(p.x), Math.round(p.y));
  const water = room?.capabilities.includes("drinking_water") ?? false;
  return h * (HEAT.moodPerHour - (water ? HEAT.waterRelief : 0));
}

/** How much lower an inpatient's mood settles in the heat. */
export function heatWardMood(state: SimState, p: Patient): number {
  return heatAt(state, p) * HEAT.wardMood;
}

/** Extra fatigue a minute for someone at work in the heat. */
export function heatFatigue(state: SimState, s: Staff): number {
  return onSite(s) ? (heatAt(state, s) * HEAT.fatiguePerHour) / 60 : 0;
}

/** Each tick: events start and end; at midnight, new ones may be forecast. */
export function updatePressure(state: SimState): void {
  const active = state.pressure.active;
  if (active.length > 0) {
    for (const e of active) {
      if (state.tick === e.announced && e.start > e.announced) forecastNotice(state, e);
      if (state.tick === e.start && e.start > e.announced) started(state, e);
    }
    if (active.some((e) => state.tick >= e.end)) {
      for (const e of active.filter((a) => state.tick >= a.end)) ended(state, e);
    }
  }
  // Once a day, at midnight.
  if ((state.tick / TICKS_PER_MINUTE + START_MINUTE_OF_DAY) % MINUTES_PER_DAY !== 0) return;
  vaccinate(state);
  forecast(state);
}

/** At midnight: each kind of event in season may be forecast. */
function forecast(state: SimState): void {
  const rate = EVENT_FREQUENCY[state.settings.eventFrequency];
  if (rate === 0) return;
  const date = dateOf(clockFromTick(state.tick).day);
  const month = date.monthIndex % 12;
  for (const def of PRESSURE_EVENTS) {
    if (!def.months.includes(month)) continue;
    const seasonDays = def.months.reduce((n, m) => n + MONTHS[m]!.days, 0);
    // Always draw, so other kinds' chances don't depend on this one's state.
    const roll = chance(state.rng, (def.perSeason * rate) / seasonDays);
    if (!roll || !canStart(state, def, date.monthIndex)) continue;
    announce(state, def);
  }
}

/**
 * Not already coming or under way (nor, for a strike, any other strike),
 * few enough this season, and long enough since the last.
 */
function canStart(state: SimState, def: PressureEventDef, monthIndex: number): boolean {
  if (state.pressure.active.some((e) => e.defId === def.id)) return false;
  if (def.strike && state.pressure.active.some((e) => pressureEventById.get(e.defId)!.strike)) {
    return false;
  }
  const year = Math.floor(monthIndex / 12);
  const thisSeason = state.pressure.past.filter(
    (p) =>
      p.defId === def.id && Math.floor(dateOf(clockFromTick(p.start).day).monthIndex / 12) === year,
  );
  if (thisSeason.length >= def.maxPerSeason) return false;
  const last = thisSeason[thisSeason.length - 1];
  return !last || state.tick - last.end >= def.gapDays * TICKS_PER_DAY;
}

/**
 * Forecasts an event (or, with no lead time, for tests and scenarios,
 * starts one at once). Most are forecast days ahead at midnight; one with
 * `leadMins` (a major incident) happens at a random time in the next day,
 * with only that much notice.
 */
export function announce(
  state: SimState,
  def: PressureEventDef,
  leadDays?: number,
  /** A scenario's script: when it starts (with a major incident's standby before that). */
  startAt?: number,
): PressureEvent {
  const length = def.hours
    ? nextInt(state.rng, def.hours[0] * 60, def.hours[1] * 60) * TICKS_PER_MINUTE
    : nextInt(state.rng, def.days[0], def.days[1]) * TICKS_PER_DAY;
  let announced = state.tick;
  let start: number;
  if (startAt !== undefined) {
    start = startAt;
    if (def.leadMins !== undefined)
      announced = Math.max(state.tick, startAt - def.leadMins * TICKS_PER_MINUTE);
  } else if (leadDays === undefined && def.leadMins !== undefined) {
    announced = state.tick + nextInt(state.rng, 0, MINUTES_PER_DAY - 1) * TICKS_PER_MINUTE;
    start = announced + def.leadMins * TICKS_PER_MINUTE;
  } else {
    const lead = leadDays ?? def.leadDays;
    start =
      lead === 0
        ? state.tick
        : tickAt(clockFromTick(state.tick).day + lead, def.startHour ?? START_HOUR);
  }
  const e: PressureEvent = {
    id: state.pressure.nextId++,
    defId: def.id,
    announced,
    start,
    end: start + length,
  };
  state.pressure.active.push(e);
  if (def.id === "major_incident") planIncident(state, e);
  if (announced === state.tick) {
    if (start > state.tick) forecastNotice(state, e);
    else started(state, e);
  }
  return e;
}

/** Forecast or under way, as the player knows it: not before it's been announced. */
export function knownEvents(state: SimState): PressureEvent[] {
  return state.pressure.active.filter((e) => e.announced <= state.tick);
}

function forecastNotice(state: SimState, e: PressureEvent): void {
  const def = pressureEventById.get(e.defId)!;
  // Planned care is rebooked around a strike as soon as notice is given.
  if (def.strike) bookAppointments(state);
  const days = Math.round((e.end - e.start) / TICKS_PER_DAY);
  const text =
    def.id === "major_incident"
      ? standbyText(state, e)
      : `${def.name} from ${formatDate(clockFromTick(e.start).day)}, for about ${days} days. ${def.levers[0]}.`;
  emit(
    state,
    text,
    def.id === "major_incident" ? "bad" : "warn",
    undefined,
    undefined,
    undefined,
    "events",
  );
}

function started(state: SimState, e: PressureEvent): void {
  const def = pressureEventById.get(e.defId)!;
  const text =
    def.id === "major_incident"
      ? `Major incident: the first casualties are on their way in.${majorIncidentDeclared(state) ? "" : " You haven't declared a major incident (Hospital → Events)."}`
      : `${def.name} has begun. ${def.description}`;
  emit(state, text, "warn", undefined, undefined, undefined, "events");
}

function ended(state: SimState, e: PressureEvent): void {
  const def = pressureEventById.get(e.defId)!;
  if (def.strike) bookAppointments(state);
  state.pressure.active = state.pressure.active.filter((a) => a !== e);
  state.pressure.past.push({ defId: e.defId, start: e.start, end: e.end });
  if (state.pressure.past.length > 50) state.pressure.past.shift();
  emit(state, `${def.name} is over.`, "info", undefined, undefined, undefined, "events");
}

/** Each autumn, with the policy on: the staff flu vaccination campaign. */
function vaccinate(state: SimState): void {
  if (!state.policies.fluVaccination) return;
  const year = yearNow(state);
  if (state.pressure.vaccinated === year) return;
  const month = dateOf(clockFromTick(state.tick).day).monthIndex % 12;
  // October to the end of February: the campaign runs ahead of and into flu season.
  if (month < FLU_VACCINATION.month || month > 10) return;
  const headcount = Object.values(state.staff).filter(
    (s) => s.contract !== "bank" && s.contract !== "agency",
  ).length;
  const cost = headcount * FLU_VACCINATION.costPerHead;
  state.money -= cost;
  book(state, "supplies", cost, "support");
  state.pressure.vaccinated = year;
  emit(
    state,
    `Staff flu vaccination campaign: ${headcount} staff offered the vaccine, costing £${cost.toLocaleString("en-GB")}.`,
    "info",
    undefined,
    undefined,
    undefined,
    "policies",
  );
}
