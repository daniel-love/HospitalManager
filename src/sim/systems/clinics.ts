/**
 * Job plans (GAME_DESIGN §5.1): each resident consultant or registrar of a
 * specialty with clinics has a number of weekly outpatient clinic sessions,
 * and surgeons a number of theatre lists. This works out which half-days
 * they fall on, and which clinic room each clinic gets. (Theatre lists get
 * their theatre and anaesthetist in systems/theatres.ts.)
 *
 * Sessions are private or NHS. In a Private Hospital every session is
 * private (taking NHS-funded patients too, where it accepts them); in a
 * Hybrid trust, consultants' private sessions come on top of their NHS job
 * plan and need Private Patient Unit rooms, while NHS sessions need rooms
 * outside it.
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
  /** A private session (see the module comment). */
  private: boolean;
}

const surgeonLists = (s: Staff, n: number) =>
  operates(s) && s.specialty !== "anaesthetics" ? n : 0;

/** Weekly sessions someone has on fixed half-days, in order: NHS clinics, NHS lists, private clinics, private lists. */
function sessionKinds(s: Staff): { kind: "clinic" | "theatre"; private: boolean; n: number }[] {
  const clinics = runsClinics(s);
  return [
    { kind: "clinic", private: false, n: clinics ? s.clinicSessions : 0 },
    { kind: "theatre", private: false, n: surgeonLists(s, s.theatreSessions) },
    { kind: "clinic", private: true, n: clinics ? s.privateClinicSessions : 0 },
    { kind: "theatre", private: true, n: surgeonLists(s, s.privateTheatreSessions) },
  ];
}

function fixedSessions(s: Staff): number {
  return sessionKinds(s).reduce((n, k) => n + k.n, 0);
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
  // A Private Hospital's sessions are all private.
  const allPrivate = state.funding === "private";
  const out: SessionSlot[] = [];
  let i = 0;
  for (const k of sessionKinds(s)) {
    for (let j = 0; j < k.n; j++, i++) {
      const slot = SESSION_ORDER[(before + i) % SESSION_ORDER.length]!;
      out.push({ ...slot, kind: k.kind, private: k.private || allPrivate });
    }
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
  private: boolean;
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
    if (fixedSessions(s) > 0) {
      plans += `${s.id}:${s.clinicSessions}:${s.theatreSessions}:${s.privateClinicSessions}:${s.privateTheatreSessions},`;
    }
  }
  // Room settings don't change the layout version, so they're part of the key.
  plans +=
    JSON.stringify(state.roomSpecialties) + JSON.stringify(state.privateRooms) + state.funding;
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
    const slot = jobPlan(state, s).find(
      (p) => p.kind === "clinic" && p.weekday === weekday && p.half === half,
    );
    if (slot) sessions.push({ day, half, staff: s, private: slot.private, roomId: null });
  }
  const free = state.rooms.filter((r) => r.valid && r.typeId === "outpatient_clinic");
  // In a Hybrid trust, private clinics are held in the Private Patient Unit and NHS ones outside it.
  const fits = (session: Session, r: (typeof free)[number]) =>
    state.funding !== "hybrid" || r.private === session.private;
  const take = (session: Session, test: (r: (typeof free)[number]) => boolean) => {
    const i = free.findIndex((r) => fits(session, r) && test(r));
    return i < 0 ? null : free.splice(i, 1)[0]!.id;
  };
  for (const session of sessions)
    session.roomId = take(session, (r) => r.specialty === session.staff.specialty);
  for (const session of sessions) {
    if (session.roomId === null) session.roomId = take(session, (r) => r.specialty === null);
  }
  return sessions;
}
