/**
 * Shifts and rotas (GAME_DESIGN §6.3). Most staff work NHS long days
 * (07:30–20:00) and nights (19:30–08:00), three a week. The player sets
 * cover levels, how many of each rota group they want on each day and night
 * shift, and everyone hired is rostered onto a weekly rota that meets them as
 * far as it can; the shifts nobody could be found for are gaps. Contracted
 * shifts left over once the cover is met are shared out in proportion to it.
 *
 * Consultants, and registrars with clinics or theatre lists, work weekdays
 * 08:00–18:00 instead. Out of hours one resident consultant of each
 * specialty is on call from home (weeknights in turn, and a whole weekend at
 * a time), called in as on-call consultants are (systems/staffing.ts).
 *
 * The rota is worked out from the staff and cover levels, so it isn't saved.
 * Who's at work is: each person's duty and the end of the shift they're on,
 * so changing the rota mid-shift doesn't send anyone home early.
 */
import { specialtyById, staffRoleById } from "@data/catalogue";
import { SHIFTS } from "@data/staff";
import { onSite, type Staff } from "../agents";
import { emit } from "../events";
import { fallbackEntrance, siteEntrance } from "../places";
import type { Cover, SimState } from "../state";
import {
  clockFromTick,
  MINUTES_PER_DAY,
  tickAt,
  TICKS_PER_MINUTE,
  WEEKDAY_NAMES,
  type GameClock,
} from "../time";
import { jobPlan } from "./clinics";
import { operates, runsClinics, staffTitle } from "./staffing";
import { callsInSick, endOfShift, fillGaps } from "./workforce";
import { isCalledIn } from "./majorIncident";

/** A week has 14 shifts: slot 2d is weekday d's day shift, 2d + 1 its night. */
export const SLOTS = 14;
/** Someone hired mid-shift starts at once if at least this much of it is left. */
const JOIN_MID_SHIFT_MINS = 60;

const isNight = (slot: number) => slot % 2 === 1;
const bit = (slot: number) => 1 << slot;

/** "Mon day", "Sat night". */
export function slotName(slot: number): string {
  return `${WEEKDAY_NAMES[slot >> 1]} ${isNight(slot) ? "night" : "day"}`;
}

/**
 * Two shifts one person can't both work: the same date's day and night
 * overlap at handover, and a night runs into the next morning's day shift.
 */
function clash(a: number, b: number): boolean {
  const da = a >> 1;
  const db = b >> 1;
  if (da === db) return true;
  if (isNight(a) && !isNight(b) && (da + 1) % 7 === db) return true;
  return isNight(b) && !isNight(a) && (db + 1) % 7 === da;
}

/** Doctors who work weekdays: consultants, and registrars with clinics or theatre lists. */
export function worksWeekdays(s: Staff): boolean {
  if (s.role === "consultant") return s.contract !== "privileges";
  return (
    s.role === "registrar" &&
    ((runsClinics(s) && s.clinicSessions > 0) || (operates(s) && s.theatreSessions > 0))
  );
}

/**
 * The group someone's shifts count towards ("porter", "nurse:band6",
 * "registrar:cardiology"), whoever employs them: bank and agency staff fill
 * gaps in a group.
 */
export function groupOf(s: Staff): string {
  if (s.role === "nurse") return `nurse:band${s.band ?? 5}`;
  return s.role === "registrar" ? `registrar:${s.specialty}` : s.role;
}

/**
 * The rota group someone is rostered in, or null if they're not on the
 * shift rota (doctors working weekdays, on-call consultants, bank and agency).
 */
export function rotaGroup(s: Staff): string | null {
  if (s.contract !== "resident" || worksWeekdays(s)) return null;
  return groupOf(s);
}

/** "Porters", "Band 6 nurses", "Cardiology registrars". */
export function groupName(key: string): string {
  const [role, rest] = key.split(":");
  const r = staffRoleById.get(role as Staff["role"]);
  if (!rest) return r?.short ?? key;
  if (role === "nurse") return `Band ${rest.replace("band", "")} nurses`;
  return `${specialtyById.get(rest as never)?.name ?? rest} ${(r?.short ?? role!).toLowerCase()}`;
}

/** The cover the player wants for a group, if they've set any. */
export function coverFor(state: SimState, key: string): Cover | null {
  const c = state.cover[key];
  return c && c.day + c.night > 0 ? c : null;
}

const rotaCache = new WeakMap<SimState, { key: string; rota: Map<number, number> }>();

/** Each rostered person's shifts in the weekly rota, as a bitmask of slots. */
export function rota(state: SimState): Map<number, number> {
  const groups = new Map<string, Staff[]>();
  let key = JSON.stringify(state.cover);
  for (const s of Object.values(state.staff).sort((a, b) => a.id - b.id)) {
    const g = rotaGroup(s);
    if (g === null) continue;
    key += `|${s.id}:${g}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s);
  }
  const hit = rotaCache.get(state);
  if (hit && hit.key === key) return hit.rota;
  const out = new Map<number, number>();
  for (const [g, people] of groups) {
    for (const [id, mask] of rosterGroup(people, coverFor(state, g))) out.set(id, mask);
  }
  rotaCache.set(state, { key, rota: out });
  return out;
}

/**
 * Rosters one group. First the cover: the shift furthest short gets the
 * person with fewest shifts so far who can work it, until every shift has
 * its cover or nobody's left who could. Then everyone's remaining contracted
 * shifts go where they keep the split between days and nights closest to
 * the cover's (or 60:40 with none set).
 */
function rosterGroup(people: Staff[], cover: Cover | null): Map<number, number> {
  const mask = new Map(people.map((p) => [p.id, 0]));
  const count = new Map(people.map((p) => [p.id, 0]));
  const filled = new Array<number>(SLOTS).fill(0);
  const fits = (id: number, slot: number) => {
    if (count.get(id)! >= SHIFTS.perWeek) return false;
    const m = mask.get(id)!;
    for (let o = 0; o < SLOTS; o++) if (m & bit(o) && clash(o, slot)) return false;
    return true;
  };
  /** Whoever can work the slot with the fewest shifts so far (hiring order breaks ties). */
  const pickFor = (slot: number) => {
    let best: number | null = null;
    for (const p of people) {
      if (!fits(p.id, slot)) continue;
      if (best === null || count.get(p.id)! < count.get(best)!) best = p.id;
    }
    return best;
  };
  const assign = (id: number, slot: number) => {
    mask.set(id, mask.get(id)! | bit(slot));
    count.set(id, count.get(id)! + 1);
    filled[slot]!++;
  };

  const target = (slot: number) => (cover ? (isNight(slot) ? cover.night : cover.day) : 0);
  const stuck = new Set<number>();
  for (;;) {
    let slot = -1;
    for (let s = 0; s < SLOTS; s++) {
      if (stuck.has(s) || filled[s]! >= target(s)) continue;
      if (slot < 0 || target(s) - filled[s]! > target(slot) - filled[slot]!) slot = s;
    }
    if (slot < 0) break;
    const who = pickFor(slot);
    if (who === null) stuck.add(slot);
    else assign(who, slot);
  }

  const weight = (slot: number) =>
    cover
      ? isNight(slot)
        ? cover.night
        : cover.day
      : isNight(slot)
        ? 1 - SHIFTS.defaultDayShare
        : SHIFTS.defaultDayShare;
  for (;;) {
    let slot = -1;
    let who: number | null = null;
    let bestLoad = Infinity;
    for (let s = 0; s < SLOTS; s++) {
      if (weight(s) <= 0) continue;
      const load = (filled[s]! + 1) / weight(s);
      if (load >= bestLoad) continue;
      const p = pickFor(s);
      if (p === null) continue;
      slot = s;
      who = p;
      bestLoad = load;
    }
    if (who === null) break;
    assign(who, slot);
  }
  return mask;
}

/** A shift under way at a tick: its slot and when it started and ends. */
export interface ShiftTime {
  slot: number;
  start: number;
  end: number;
}

const T = TICKS_PER_MINUTE;

/** The shifts under way at a tick: one, or two during handover. */
export function shiftsAt(tick: number): ShiftTime[] {
  const c = clockFromTick(tick);
  const midnight = tickAt(c.day, 0);
  const len = SHIFTS.lengthMins * T;
  const out: ShiftTime[] = [];
  const add = (weekday: number, night: boolean, start: number) => {
    if (tick >= start && tick < start + len) {
      out.push({ slot: ((weekday + 7) % 7) * 2 + (night ? 1 : 0), start, end: start + len });
    }
  };
  add(c.weekday - 1, true, midnight - (MINUTES_PER_DAY - SHIFTS.nightStart) * T);
  add(c.weekday, false, midnight + SHIFTS.dayStart * T);
  add(c.weekday, true, midnight + SHIFTS.nightStart * T);
  return out;
}

const minuteOf = (c: GameClock) => c.hour * 60 + c.minute;

/** Weekday hours for doctors who work them: Monday to Friday, 08:00–18:00. */
function inWeekdayHours(c: GameClock): boolean {
  const m = minuteOf(c);
  return c.weekday < 5 && m >= SHIFTS.weekdayStart && m < SHIFTS.weekdayEnd;
}

/**
 * The resident consultant of a specialty on call from home now (out of
 * hours), or null. Weeknights go round the team in turn; a weekend, from
 * Friday evening to Monday morning, is one person's.
 */
export function consultantOnCall(state: SimState, specialty: string, tick = state.tick) {
  const c = clockFromTick(tick);
  if (inWeekdayHours(c)) return null;
  const team = Object.values(state.staff)
    .filter(
      (s) => s.role === "consultant" && s.contract === "resident" && s.specialty === specialty,
    )
    .sort((a, b) => a.id - b.id);
  if (team.length === 0) return null;
  // The evening this stretch of out-of-hours began on.
  const day = minuteOf(c) < SHIFTS.weekdayStart ? c.day - 1 : c.day;
  const weekday = (((day - 1) % 7) + 7) % 7;
  const turn = weekday >= 4 ? Math.floor((day - 1) / 7) : day;
  return team[turn % team.length]!;
}

/** Brings someone to work: in from the site entrance if they were at home. */
function comeIn(state: SimState, s: Staff, shiftEnd: number | null): void {
  if (!onSite(s)) {
    const at = siteEntrance(state) ?? fallbackEntrance(state);
    Object.assign(s, { x: at.x, y: at.y, prevX: at.x, prevY: at.y, path: [], dest: null });
    s.lastActiveTick = state.tick;
  }
  s.onCall = null;
  s.duty = "on";
  if (shiftEnd !== null && s.shiftEnd !== shiftEnd) {
    s.shiftLoad = { mins: 0, busy: 0, short: false };
    state.today.stats.shifts++;
  }
  s.shiftEnd = shiftEnd;
}

/** Called in from home (a major incident): at work until they're stood down. */
export function callIn(state: SimState, s: Staff): void {
  comeIn(state, s, null);
}

/** Sends someone home at the end of their shift: they finish what they're doing first. */
function finish(s: Staff): void {
  if (s.duty === "on") {
    s.duty = onSite(s) ? "leaving" : "off";
    endOfShift(s);
  }
  s.shiftEnd = null;
}

/** Off sick for a shift that's starting: they stay at home, and say so. */
function sickFor(state: SimState, s: Staff, until: number, shift: string): boolean {
  if (!callsInSick(state, s)) return false;
  s.sickUntil = until;
  state.today.stats.sickShifts++;
  emit(state, `${s.name}, ${staffTitle(s)}, has called in sick for ${shift}`, "info", undefined, {
    tab: "team",
    id: s.id,
  });
  return true;
}

const isSick = (state: SimState, s: Staff) => s.sickUntil !== null && state.tick < s.sickUntil;

/** Once a minute: shifts start and end, and consultants go on and off call. */
export function updateShifts(state: SimState): void {
  if (state.tick % T !== 0) return;
  const c = clockFromTick(state.tick);
  for (const s of Object.values(state.staff)) {
    if (s.contract === "privileges") privilegesDuty(state, s, c);
  }
  if (!state.settings.rotas) {
    for (const s of Object.values(state.staff)) {
      if (s.contract === "on_call" || s.contract === "privileges") continue;
      if (s.duty !== "on" || s.onCall) comeIn(state, s, null);
      s.shiftEnd = null;
    }
    return;
  }
  const plan = rota(state);
  const now = shiftsAt(state.tick);
  for (const s of Object.values(state.staff)) {
    if (s.contract === "on_call" || s.contract === "privileges") continue;
    // Called in for a major incident: they stay until it's stood down.
    if (isCalledIn(state, s)) continue;
    if (worksWeekdays(s)) weekdayDuty(state, s, c);
    else rosteredDuty(state, s, plan.get(s.id) ?? 0, now);
  }
  const starting = now.find((t) => t.start === state.tick);
  if (starting) fillGaps(state, starting);
}

function rosteredDuty(state: SimState, s: Staff, mask: number, now: ShiftTime[]): void {
  if (s.onCall) {
    // A consultant's job plan changed under them: no longer on call.
    s.onCall = null;
    s.duty = onSite(s) ? "leaving" : "off";
  }
  if (s.duty === "on") {
    if (s.shiftEnd === null) {
      // At work without a shift: rotas just came on, or they've joined the rota.
      const shift = now.find((t) => mask & bit(t.slot));
      if (shift) s.shiftEnd = shift.end;
      else finish(s);
    } else if (state.tick >= s.shiftEnd) finish(s);
  }
  if (s.duty !== "on") {
    const starting = now.find((t) => t.start === state.tick && mask & bit(t.slot));
    if (starting && !sickFor(state, s, starting.end, `the ${slotName(starting.slot)} shift`)) {
      comeIn(state, s, starting.end);
    }
  }
}

/**
 * Consultants with practising privileges aren't employed: they come in on
 * weekdays they have a session (08:00 to 18:00), and aren't on call.
 */
function privilegesDuty(state: SimState, s: Staff, c: GameClock): void {
  const today = inWeekdayHours(c) && jobPlan(state, s).some((p) => p.weekday === c.weekday);
  if (today) {
    if (s.duty !== "on" || s.shiftEnd === null) {
      comeIn(state, s, tickAt(c.day, 0) + SHIFTS.weekdayEnd * T);
    }
  } else finish(s);
}

function weekdayDuty(state: SimState, s: Staff, c: GameClock): void {
  if (inWeekdayHours(c)) {
    const end = tickAt(c.day, 0) + SHIFTS.weekdayEnd * T;
    if (isSick(state, s)) return;
    const startOfDay = minuteOf(c) === SHIFTS.weekdayStart && state.tick > s.hiredTick;
    if (startOfDay && !onSite(s) && sickFor(state, s, end, "today")) return;
    if (s.duty !== "on" || s.onCall || s.shiftEnd === null) comeIn(state, s, end);
    return;
  }
  s.shiftEnd = null;
  if (s.specialty && consultantOnCall(state, s.specialty)?.id === s.id) {
    if (!s.onCall) {
      // Stays to finish what they're doing, then goes home to be on call.
      s.onCall = { state: onSite(s) ? "leaving" : "home", at: state.tick };
      s.duty = "on";
    }
    return;
  }
  if (s.onCall) {
    const here = onSite(s);
    s.onCall = null;
    s.duty = here ? "leaving" : "off";
  } else finish(s);
}

/**
 * Someone just hired: with rotas on they start at their first shift, or at
 * once if one of theirs is under way with enough of it left and their group
 * is short right now (fewer at work than the cover, or nobody without one).
 */
export function startOnRota(state: SimState, s: Staff): void {
  if (s.contract === "privileges") {
    // In for their sessions only (privilegesDuty).
    s.duty = "off";
    return;
  }
  if (!state.settings.rotas || s.contract === "on_call") return;
  s.duty = "off";
  if (worksWeekdays(s)) {
    weekdayDuty(state, s, clockFromTick(state.tick));
    return;
  }
  const group = rotaGroup(s)!;
  const mask = rota(state).get(s.id) ?? 0;
  const shift = shiftsAt(state.tick).find(
    (t) => mask & bit(t.slot) && t.end - state.tick >= JOIN_MID_SHIFT_MINS * T,
  );
  if (!shift) return;
  const cover = coverFor(state, group);
  const want = cover ? (isNight(shift.slot) ? cover.night : cover.day) : 1;
  const atWork = Object.values(state.staff).filter(
    (o) => o.id !== s.id && rotaGroup(o) === group && o.duty === "on" && onSite(o),
  ).length;
  if (atWork < want) comeIn(state, s, shift.end);
}

/** Sets a group's cover levels; zero for both clears them. */
export function setCover(state: SimState, key: string, cover: Cover): void {
  const day = Math.max(0, Math.min(99, Math.round(cover.day)));
  const night = Math.max(0, Math.min(99, Math.round(cover.night)));
  if (day + night === 0) delete state.cover[key];
  else state.cover[key] = { day, night };
}

/** A rota group at a glance, for the Staff screen. */
export interface RotaGroupSummary {
  key: string;
  name: string;
  people: number;
  cover: Cover | null;
  /** People rostered on each of the week's 14 shifts. */
  filled: number[];
  /** Shifts a week short of the cover, counting each missing person. */
  gaps: number;
  /** At work now. */
  onNow: number;
}

/** Every rota group with someone in it or cover set. */
export function rotaSummary(state: SimState): RotaGroupSummary[] {
  const plan = rota(state);
  const groups = new Map<string, Staff[]>();
  for (const s of Object.values(state.staff)) {
    const g = rotaGroup(s);
    if (g === null) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s);
  }
  for (const key of Object.keys(state.cover)) if (!groups.has(key)) groups.set(key, []);
  return [...groups.entries()]
    .map(([key, people]) => {
      const filled = new Array<number>(SLOTS).fill(0);
      for (const p of people) {
        const m = plan.get(p.id) ?? 0;
        for (let s = 0; s < SLOTS; s++) if (m & bit(s)) filled[s]!++;
      }
      const cover = coverFor(state, key);
      let gaps = 0;
      if (cover) {
        for (let s = 0; s < SLOTS; s++) {
          gaps += Math.max(0, (isNight(s) ? cover.night : cover.day) - filled[s]!);
        }
      }
      return {
        key,
        name: groupName(key),
        people: people.length,
        cover,
        filled,
        gaps,
        onNow: Object.values(state.staff).filter(
          (p) => groupOf(p) === key && onSite(p) && p.duty === "on",
        ).length,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Someone's working pattern, for the inspector: "Mon day, Wed night, Sat night". */
export function describeRota(state: SimState, s: Staff): string {
  if (s.contract === "on_call") return "On call from home whenever they're needed";
  if (s.contract === "privileges") {
    return "Practising privileges: in on weekdays with a clinic or list, not on call";
  }
  if (s.contract === "bank" || s.contract === "agency") {
    return `One ${s.contract} shift, filling a rota gap`;
  }
  if (!state.settings.rotas) return "Works around the clock (rotas are off)";
  if (worksWeekdays(s)) {
    const oncall = s.role === "consultant" ? "; takes turns on call from home out of hours" : "";
    return `Weekdays 08:00 to 18:00${oncall}`;
  }
  const m = rota(state).get(s.id) ?? 0;
  const slots = [...Array(SLOTS).keys()].filter((i) => m & bit(i));
  return slots.length > 0 ? slots.map(slotName).join(", ") : "No shifts: the rota is full";
}

/** When someone off duty is next at work: "Tue night (19:30)", or null if never. */
export function nextShift(state: SimState, s: Staff): string | null {
  if (!state.settings.rotas || s.contract !== "resident") return null;
  const step = 30 * T;
  for (let t = state.tick + step; t < state.tick + 8 * MINUTES_PER_DAY * T; t += step) {
    const c = clockFromTick(t);
    if (worksWeekdays(s)) {
      if (inWeekdayHours(c)) return `${WEEKDAY_NAMES[c.weekday]} 08:00`;
      continue;
    }
    const mask = rota(state).get(s.id) ?? 0;
    const shift = shiftsAt(t).find((x) => mask & bit(x.slot) && x.start > state.tick);
    if (shift) {
      const at = clockFromTick(shift.start);
      const hh = String(at.hour).padStart(2, "0");
      const mm = String(at.minute).padStart(2, "0");
      return `${slotName(shift.slot)} (${hh}:${mm})`;
    }
  }
  return null;
}
