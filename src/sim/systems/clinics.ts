/**
 * Job plans (GAME_DESIGN §5.1): each resident consultant or registrar of a
 * specialty with clinics has a number of weekly outpatient clinic sessions,
 * and surgeons a number of theatre lists. This works out which half-days
 * they fall on, and which clinic room each clinic gets. (Theatre lists get
 * their theatre and anaesthetist in systems/theatres.ts.)
 */
import { SESSION_ORDER, type SessionHalf } from "@data/outpatients";
import type { Staff } from "../agents";
import type { SimState } from "../state";
import { WEEKDAY_NAMES } from "../time";
import { operates, runsClinics } from "./staffing";

export interface SessionSlot {
  /** 0 Monday … 4 Friday. */
  weekday: number;
  half: SessionHalf;
  kind: "clinic" | "theatre";
}

/** Weekly sessions in someone's job plan that fall on fixed half-days. */
function fixedSessions(s: Staff): number {
  const lists = operates(s) && s.specialty !== "anaesthetics" ? s.theatreSessions : 0;
  return (runsClinics(s) ? s.clinicSessions : 0) + lists;
}

/**
 * The half-days a clinician's clinics and theatre lists fall on each week:
 * clinics first, then lists. Their colleagues of the same specialty hired
 * before them fill the earlier half-days, so a team's sessions spread across
 * the week rather than all wanting the same rooms at once. Anaesthetists
 * have no fixed half-days: they're paired with surgeons' lists.
 */
export function jobPlan(state: SimState, s: Staff): SessionSlot[] {
  const total = fixedSessions(s);
  if (total === 0) return [];
  let before = 0;
  for (const o of Object.values(state.staff)) {
    if (o.id < s.id && o.specialty === s.specialty) before += fixedSessions(o);
  }
  const clinics = runsClinics(s) ? s.clinicSessions : 0;
  const out: SessionSlot[] = [];
  for (let i = 0; i < total; i++) {
    const slot = SESSION_ORDER[(before + i) % SESSION_ORDER.length]!;
    out.push({ ...slot, kind: i < clinics ? "clinic" : "theatre" });
  }
  return out.sort((a, b) => a.weekday - b.weekday || (a.half === "am" ? -1 : 1));
}

/** "Mon morning, Wed afternoon". */
export function describeJobPlan(slots: readonly { weekday: number; half: SessionHalf }[]): string {
  return slots
    .map((s) => `${WEEKDAY_NAMES[s.weekday]} ${s.half === "am" ? "morning" : "afternoon"}`)
    .join(", ");
}

/** A clinic session on a given day: who runs it, and the clinic room they'll have. */
export interface Session {
  day: number;
  half: SessionHalf;
  staff: Staff;
  /** The clinic room (a Room id) it's held in, or null if there's none free. */
  roomId: number | null;
}

/**
 * The clinic sessions on a day's morning or afternoon, from everyone's job
 * plan. Each gets a working clinic room: one of their own specialty if
 * there's one free, otherwise one open to any specialty. With more sessions
 * than rooms, those left over can't run (roomId null).
 */
export function sessionsOn(state: SimState, day: number, half: SessionHalf): Session[] {
  const weekday = (day - 1) % 7;
  if (weekday > 4) return [];
  // Cached until the layout or anyone's job plan changes.
  let plans = "";
  for (const s of Object.values(state.staff)) {
    if (s.clinicSessions + s.theatreSessions > 0) {
      plans += `${s.id}:${s.clinicSessions}:${s.theatreSessions},`;
    }
  }
  // Room settings don't change the layout version, so they're part of the key.
  plans += JSON.stringify(state.roomSpecialties);
  const key = `${day}:${half}:${state.layoutVersion}:${plans}`;
  let cache = sessionCache.get(state);
  if (!cache || cache.plans !== plans || cache.layout !== state.layoutVersion) {
    cache = { plans, layout: state.layoutVersion, sessions: new Map() };
    sessionCache.set(state, cache);
  }
  const hit = cache.sessions.get(key);
  if (hit) return hit;
  const result = findSessions(state, day, weekday, half);
  cache.sessions.set(key, result);
  return result;
}

const sessionCache = new WeakMap<
  SimState,
  { plans: string; layout: number; sessions: Map<string, Session[]> }
>();

function findSessions(state: SimState, day: number, weekday: number, half: SessionHalf): Session[] {
  const sessions: Session[] = [];
  for (const s of Object.values(state.staff).sort((a, b) => a.id - b.id)) {
    const plan = jobPlan(state, s);
    if (plan.some((p) => p.kind === "clinic" && p.weekday === weekday && p.half === half)) {
      sessions.push({ day, half, staff: s, roomId: null });
    }
  }
  const free = state.rooms.filter((r) => r.valid && r.typeId === "outpatient_clinic");
  const take = (test: (r: (typeof free)[number]) => boolean) => {
    const i = free.findIndex(test);
    return i < 0 ? null : free.splice(i, 1)[0]!.id;
  };
  for (const session of sessions)
    session.roomId = take((r) => r.specialty === session.staff.specialty);
  for (const session of sessions) {
    if (session.roomId === null) session.roomId = take((r) => r.specialty === null);
  }
  return sessions;
}
