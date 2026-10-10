/**
 * GP referrals and outpatient waiting lists (GAME_DESIGN §5.1, §8.5).
 *
 * GPs refer patients to a specialty's clinics only if the hospital runs
 * them: a working Outpatients Reception, an Outpatient Clinic Room for the
 * specialty (or open to any), and a resident consultant of it with clinic
 * sessions in their job plan.
 * Referrals come in on weekdays, in surgery hours, at the catchment's rate.
 *
 * Each referral starts an 18-week referral-to-treatment (RTT) clock and
 * waits for a first appointment. Appointments are booked into clinicians'
 * sessions up to BOOKING_HORIZON_DAYS ahead: urgent (suspected cancer)
 * referrals first, then follow-ups near their due date, then everyone else,
 * longest wait first. With too few sessions, the list grows. Booked
 * appointments whose session stops running (the clinician's job plan
 * changes, they leave, or there's no room) are cancelled and rebooked.
 *
 * People on the list are only records: they become agents on the day of
 * their appointment (systems/clinics.ts).
 */
import { content, specialtyById } from "@data/catalogue";
import { FIRST_NAMES, SURNAMES } from "@data/names";
import { CLINIC_SESSIONS, RTT_TARGET_DAYS, type SessionHalf } from "@data/outpatients";
import type { OutpatientService, SpecialtyId } from "@data/schema";
import type { Referral } from "../agents";
import { chance, pick } from "../rng";
import type { SimState } from "../state";
import { clockFromTick, TICKS_PER_DAY, TICKS_PER_MINUTE, tickAt } from "../time";
import { sessionsOn } from "./clinics";
import { outpatientDesks } from "./outpatients";
import { runsClinics } from "./staffing";

/** How far ahead appointments are booked, in days. */
export const BOOKING_HORIZON_DAYS = 42;
/** Follow-ups are booked from this many days before they're due. */
const FOLLOW_UP_EARLY_DAYS = 7;
/** GPs send referrals Monday to Friday between these hours. */
const GP_HOURS = { start: 8, end: 18 };

/** The specialty's clinic service, if it has one. */
export function serviceOf(specialty: SpecialtyId): OutpatientService | undefined {
  return specialtyById.get(specialty)?.outpatients;
}

/**
 * Whether GPs can refer to this specialty's clinics here: a working clinic
 * room for it (or open to any), and a resident consultant of it with
 * clinic sessions.
 */
export function offersClinic(state: SimState, specialty: SpecialtyId): boolean {
  if (!serviceOf(specialty) || outpatientDesks(state).length === 0) return false;
  const room = state.rooms.some(
    (r) =>
      r.valid &&
      r.typeId === "outpatient_clinic" &&
      (r.specialty === null || r.specialty === specialty),
  );
  if (!room) return false;
  return Object.values(state.staff).some(
    (s) =>
      s.role === "consultant" &&
      s.specialty === specialty &&
      runsClinics(s) &&
      s.clinicSessions > 0,
  );
}

/** GP referrals a day to this specialty's clinics, for the catchment. */
export function referralsPerDay(state: SimState, specialty: SpecialtyId): number {
  const service = serviceOf(specialty);
  if (!service) return 0;
  return (
    (service.referralsPer100k * state.settings.catchment * state.settings.patientVolume) / 100_000
  );
}

/** Every minute: new GP referrals; once a night, the waiting lists are booked. */
export function updateReferrals(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE !== 0) return;
  const c = clockFromTick(state.tick);
  if (c.hour === 0 && c.minute === 5) bookAppointments(state);
  if (c.weekday > 4 || c.hour < GP_HOURS.start || c.hour >= GP_HOURS.end) return;
  // A week's referrals arrive over five days' surgery hours.
  const minutes = 5 * (GP_HOURS.end - GP_HOURS.start) * 60;
  let added = false;
  for (const sp of content.specialties) {
    if (!sp.outpatients || !offersClinic(state, sp.id)) continue;
    const perMinute = (referralsPerDay(state, sp.id) * 7) / minutes;
    if (chance(state.rng, perMinute)) {
      refer(state, sp.id, chance(state.rng, sp.outpatients.urgentShare));
      added = true;
    }
  }
  if (added) bookAppointments(state);
}

/** A GP referral: onto the list for a first appointment, with the RTT clock started. */
export function refer(state: SimState, specialty: SpecialtyId, urgent = false): Referral {
  const r: Referral = {
    id: state.nextReferralId++,
    name: `${pick(state.rng, FIRST_NAMES)} ${pick(state.rng, SURNAMES)}`,
    specialty,
    kind: "first",
    urgent,
    clockStart: state.tick,
    added: state.tick,
    due: null,
    dnas: 0,
    booking: null,
  };
  state.referrals[r.id] = r;
  state.today.stats.gpReferrals++;
  return r;
}

/** One clinic session's diary over the booking horizon. */
interface Diary {
  specialty: SpecialtyId;
  staffId: number;
  day: number;
  half: SessionHalf;
  start: number;
  end: number;
  /** The tick the next booking would start at. */
  next: number;
}

function sessionKey(staffId: number, day: number, half: SessionHalf): string {
  return `${staffId}:${day}:${half}`;
}

/** Sessions that will run between `fromDay` and `toDay` (inclusive), with room for them. */
function diaries(state: SimState, fromDay: number, toDay: number): Map<string, Diary> {
  const out = new Map<string, Diary>();
  for (let day = fromDay; day <= toDay; day++) {
    for (const half of ["am", "pm"] as const) {
      for (const session of sessionsOn(state, day, half)) {
        if (session.roomId === null || !session.staff.specialty) continue;
        const times = CLINIC_SESSIONS[half];
        const start = tickAt(day, 0) + times.start * TICKS_PER_MINUTE;
        out.set(sessionKey(session.staff.id, day, half), {
          specialty: session.staff.specialty,
          staffId: session.staff.id,
          day,
          half,
          start,
          end: tickAt(day, 0) + times.end * TICKS_PER_MINUTE,
          next: start,
        });
      }
    }
  }
  return out;
}

/** Which order the list is booked in: urgent first, follow-ups when due, then longest wait. */
function bookingOrder(a: Referral, b: Referral): number {
  const rank = (r: Referral) =>
    r.urgent && r.kind === "first" ? 0 : r.kind === "follow_up" ? 1 : 2;
  const when = (r: Referral) => (r.kind === "follow_up" ? r.due! : (r.clockStart ?? r.added));
  return rank(a) - rank(b) || when(a) - when(b) || a.id - b.id;
}

/**
 * Books everyone on a list for a clinic appointment who can be, into the
 * earliest session with room for them, and cancels bookings whose session
 * won't run any more.
 */
export function bookAppointments(state: SimState): void {
  const today = clockFromTick(state.tick).day;
  const sessions = diaries(state, today, today + BOOKING_HORIZON_DAYS);
  const waiting: Referral[] = [];
  for (const r of Object.values(state.referrals)) {
    if (r.kind === "surgery") continue;
    const b = r.booking;
    if (!b) {
      waiting.push(r);
      continue;
    }
    if (b.at < state.tick) continue; // Today's: the clinic deals with it.
    const diary = sessions.get(sessionKey(b.staffId, b.day, b.half));
    if (!diary || diary.specialty !== r.specialty) {
      // The session isn't running any more: the hospital cancels.
      r.booking = null;
      state.today.stats.clinicCancellations++;
      waiting.push(r);
      continue;
    }
    diary.next = Math.max(diary.next, b.at + b.mins * TICKS_PER_MINUTE);
  }
  if (waiting.length === 0) return;

  const bySpecialty = new Map<SpecialtyId, Diary[]>();
  for (const d of sessions.values()) {
    if (!bySpecialty.has(d.specialty)) bySpecialty.set(d.specialty, []);
    bySpecialty.get(d.specialty)!.push(d);
  }
  for (const list of bySpecialty.values()) list.sort((a, b) => a.start - b.start);

  // Nothing is booked for today, or before the referral is a day old.
  const tomorrow = tickAt(today + 1, 0);
  for (const r of waiting.sort(bookingOrder)) {
    const service = serviceOf(r.specialty);
    const list = bySpecialty.get(r.specialty);
    if (!service || !list) continue;
    const mins = r.kind === "first" ? service.firstSlotMins : service.followUpSlotMins;
    const earliest =
      r.kind === "follow_up"
        ? Math.max(tomorrow, r.due! - FOLLOW_UP_EARLY_DAYS * TICKS_PER_DAY)
        : tomorrow;
    const diary = list.find(
      (d) => d.start >= earliest && d.next + mins * TICKS_PER_MINUTE <= d.end,
    );
    if (!diary) continue;
    r.booking = { day: diary.day, half: diary.half, staffId: diary.staffId, at: diary.next, mins };
    diary.next += mins * TICKS_PER_MINUTE;
  }
}

export interface ListSummary {
  specialty: SpecialtyId;
  name: string;
  /** Waiting for a first appointment (booked or not). */
  firstWaiting: number;
  /** Of them, with an appointment booked. */
  booked: number;
  followUps: number;
  /** Waiting for surgery (from step 7, the theatre lists). */
  surgery: number;
  /** RTT clocks running, and how many under 18 weeks. */
  pathways: number;
  within18w: number;
  /** The longest wait on an RTT clock, in weeks. */
  longestWeeks: number;
  /** Whether GPs can refer here at the moment. */
  open: boolean;
}

/** Waiting lists by specialty, for reports. */
export function waitingLists(state: SimState): ListSummary[] {
  const out: ListSummary[] = [];
  for (const sp of content.specialties) {
    if (!sp.outpatients) continue;
    const mine = Object.values(state.referrals).filter((r) => r.specialty === sp.id);
    const open = offersClinic(state, sp.id);
    if (mine.length === 0 && !open) continue;
    const s: ListSummary = {
      specialty: sp.id,
      name: sp.name,
      firstWaiting: 0,
      booked: 0,
      followUps: 0,
      surgery: 0,
      pathways: 0,
      within18w: 0,
      longestWeeks: 0,
      open,
    };
    for (const r of mine) {
      if (r.kind === "first") {
        s.firstWaiting++;
        if (r.booking) s.booked++;
      } else if (r.kind === "follow_up") s.followUps++;
      else s.surgery++;
      if (r.clockStart === null) continue;
      const days = (state.tick - r.clockStart) / TICKS_PER_DAY;
      s.pathways++;
      if (days < RTT_TARGET_DAYS) s.within18w++;
      s.longestWeeks = Math.max(s.longestWeeks, Math.floor(days / 7));
    }
    out.push(s);
  }
  return out;
}
