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
 *
 * Private care (GAME_DESIGN §2.2): a Private Hospital, or a Hybrid trust's
 * Private Patient Unit, also gets private referrals, insured or self-pay,
 * at a share of the catchment's GP referral rate that follows reputation
 * (and, for self-pay, the price level). They're booked into private
 * sessions only. A Private Hospital can also take NHS referrals for a
 * specialty (patient choice), into the same sessions after private
 * patients. The 18-week standard is for NHS patients.
 */
import { content, specialtyById } from "@data/catalogue";
import { FIRST_NAMES, SURNAMES } from "@data/names";
import { CLINIC_SESSIONS, RTT_TARGET_DAYS, type SessionHalf } from "@data/outpatients";
import type { OutpatientService, SpecialtyId } from "@data/schema";
import { PRIVATE } from "@data/economy";
import { income, type Payer, type Referral } from "../agents";
import { chance, nextFloat, pick } from "../rng";
import type { SimState } from "../state";
import { clockFromTick, TICKS_PER_DAY, TICKS_PER_MINUTE, tickAt } from "../time";
import { sessionsOn } from "./clinics";
import { canRun, listsOn, TURNAROUND_MINS } from "./theatres";
import { outpatientDesks } from "./outpatients";
import { reputationFactor } from "./reputation";
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
 * Whether there's somewhere to hold this specialty's clinics of a kind
 * (private or NHS): an Outpatients Reception, a working clinic room for it
 * (or open to any; in a Hybrid trust, inside the Private Patient Unit for
 * private clinics and outside it for NHS ones), and a consultant of it
 * with sessions of that kind.
 */
function holdsClinics(state: SimState, specialty: SpecialtyId, isPrivate: boolean): boolean {
  if (!serviceOf(specialty) || outpatientDesks(state).length === 0) return false;
  const hybrid = state.funding === "hybrid";
  const room = state.rooms.some(
    (r) =>
      r.valid &&
      r.typeId === "outpatient_clinic" &&
      (r.specialty === null || r.specialty === specialty) &&
      (!hybrid || r.private === isPrivate),
  );
  if (!room) return false;
  return Object.values(state.staff).some(
    (s) =>
      s.role === "consultant" &&
      s.specialty === specialty &&
      runsClinics(s) &&
      (hybrid && isPrivate ? s.privateClinicSessions : s.clinicSessions) > 0,
  );
}

/**
 * Whether GPs can refer NHS patients to this specialty's clinics here. In a
 * Private Hospital, only for specialties it takes NHS referrals for.
 */
export function offersClinic(state: SimState, specialty: SpecialtyId): boolean {
  if (state.funding === "private") {
    return !!state.policies.nhsReferrals[specialty] && holdsClinics(state, specialty, true);
  }
  return holdsClinics(state, specialty, false);
}

/**
 * Whether private patients can be referred to this specialty's clinics: in
 * a Private Hospital, or a Hybrid trust's Private Patient Unit while its
 * private income is under the cap.
 */
export function offersPrivateClinic(state: SimState, specialty: SpecialtyId): boolean {
  if (state.funding === "nhs") return false;
  if (state.funding === "hybrid" && overPrivateCap(state)) return false;
  return holdsClinics(state, specialty, true);
}

/** Private income's share of all income over the last PRIVATE.capDays days. */
export function privateIncomeShare(state: SimState): number {
  const days = state.history.slice(-PRIVATE.capDays);
  let all = 0;
  let priv = 0;
  for (const d of days) {
    all += income(d.ledger);
    priv += d.ledger.private;
  }
  return all > 0 ? priv / all : 0;
}

/** Hybrid trusts: private income at or over the regulator's cap (the 49% rule). */
export function overPrivateCap(state: SimState): boolean {
  return state.funding === "hybrid" && privateIncomeShare(state) >= PRIVATE.incomeCap;
}

/**
 * Private referrals a day to this specialty, if the hospital offers private
 * clinics for it: insured and self-pay, scaled by reputation, self-pay also
 * by price.
 */
export function privateReferralsPerDay(
  state: SimState,
  specialty: SpecialtyId,
): { insured: number; selfPay: number } {
  const base = referralsPerDay(state, specialty) * reputationFactor(state);
  const price = state.policies.priceLevel ** -PRIVATE.priceElasticity;
  return { insured: base * PRIVATE.insuredShare, selfPay: base * PRIVATE.selfPayShare * price };
}

/** NHS referrals a day to this specialty here (a Private Hospital gets those who choose it). */
function nhsReferralsPerDay(state: SimState, specialty: SpecialtyId): number {
  const all = referralsPerDay(state, specialty);
  return state.funding === "private"
    ? all * PRIVATE.nhsChoiceShare * reputationFactor(state)
    : all;
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
    if (!sp.outpatients) continue;
    if (offersClinic(state, sp.id)) {
      const perMinute = (nhsReferralsPerDay(state, sp.id) * 7) / minutes;
      if (chance(state.rng, perMinute)) {
        refer(state, sp.id, chance(state.rng, sp.outpatients.urgentShare));
        added = true;
      }
    }
    if (!offersPrivateClinic(state, sp.id)) continue;
    const p = privateReferralsPerDay(state, sp.id);
    const r = (nextFloat(state.rng) * minutes) / 7;
    const payer = r < p.insured ? "insured" : r < p.insured + p.selfPay ? "self_pay" : null;
    if (payer) {
      refer(state, sp.id, chance(state.rng, sp.outpatients.urgentShare), payer);
      added = true;
    }
  }
  if (added) bookAppointments(state);
}

/** A GP referral: onto the list for a first appointment, with the RTT clock started. */
export function refer(
  state: SimState,
  specialty: SpecialtyId,
  urgent = false,
  payer: Payer = "nhs",
): Referral {
  const r: Referral = {
    id: state.nextReferralId++,
    name: `${pick(state.rng, FIRST_NAMES)} ${pick(state.rng, SURNAMES)}`,
    specialty,
    payer,
    kind: "first",
    urgent,
    clockStart: state.tick,
    added: state.tick,
    due: null,
    dnas: 0,
    booking: null,
    dayCase: false,
    rebookBy: null,
  };
  state.referrals[r.id] = r;
  if (payer === "nhs") state.today.stats.gpReferrals++;
  else state.today.stats.privateReferrals++;
  return r;
}

/** One clinic session's diary over the booking horizon. */
interface Diary {
  /** A theatre list rather than a clinic. */
  theatre: boolean;
  /** A private session (clinics.ts SessionSlot.private). */
  private: boolean;
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
          theatre: false,
          private: session.private,
          specialty: session.staff.specialty,
          staffId: session.staff.id,
          day,
          half,
          start,
          end: tickAt(day, 0) + times.end * TICKS_PER_MINUTE,
          next: start,
        });
      }
      for (const list of listsOn(state, day, half)) {
        if (!canRun(list) || !list.surgeon.specialty) continue;
        const times = CLINIC_SESSIONS[half];
        const start = tickAt(day, 0) + times.start * TICKS_PER_MINUTE;
        out.set(sessionKey(list.surgeon.id, day, half), {
          theatre: true,
          private: list.private,
          specialty: list.surgeon.specialty,
          staffId: list.surgeon.id,
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

/**
 * Which order the lists are booked in. Clinics: urgent first, follow-ups
 * when due, then the longest wait. Surgery: operations cancelled on the day
 * (to be done within 28 days), then urgent, then the longest wait.
 */
function bookingOrder(a: Referral, b: Referral): number {
  const rank = (r: Referral) =>
    r.rebookBy !== null
      ? 0
      : r.urgent && r.kind !== "follow_up"
        ? 1
        : r.kind === "follow_up"
          ? 2
          : 3;
  const when = (r: Referral) =>
    r.rebookBy ?? (r.kind === "follow_up" ? r.due! : (r.clockStart ?? r.added));
  // Where they share sessions (a Private Hospital), private patients come first.
  const nhs = (r: Referral) => (r.payer === "nhs" ? 1 : 0);
  return rank(a) - rank(b) || nhs(a) - nhs(b) || when(a) - when(b) || a.id - b.id;
}

/**
 * Whether a session can take this patient: private patients only private
 * sessions; NHS patients NHS ones, or in a Private Hospital (where every
 * session is private), any.
 */
function canBook(state: SimState, r: Referral, d: Diary): boolean {
  if (r.payer !== "nhs") return d.private;
  return !d.private || state.funding === "private";
}

/** How long a booking takes: a clinic slot, or an operation and the turnaround after it. */
function slotMins(r: Referral): number | null {
  if (r.kind === "surgery") {
    const op = specialtyById.get(r.specialty)?.surgery;
    return op ? Math.round((op.opMins[0] + op.opMins[1]) / 2) + TURNAROUND_MINS : null;
  }
  const service = serviceOf(r.specialty);
  if (!service) return null;
  return r.kind === "first" ? service.firstSlotMins : service.followUpSlotMins;
}

/**
 * Books everyone on a list who can be, into the earliest clinic session (or
 * theatre list) with room for them, and cancels bookings whose session
 * won't run any more.
 */
export function bookAppointments(state: SimState): void {
  const today = clockFromTick(state.tick).day;
  const sessions = diaries(state, today, today + BOOKING_HORIZON_DAYS);
  const waiting: Referral[] = [];
  for (const r of Object.values(state.referrals)) {
    const b = r.booking;
    if (!b) {
      waiting.push(r);
      continue;
    }
    if (b.at < state.tick) continue; // Today's: the clinic deals with it.
    const diary = sessions.get(sessionKey(b.staffId, b.day, b.half));
    const surgery = r.kind === "surgery";
    if (
      !diary ||
      diary.specialty !== r.specialty ||
      diary.theatre !== surgery ||
      !canBook(state, r, diary)
    ) {
      // The session isn't running any more: the hospital cancels and rebooks.
      r.booking = null;
      if (!surgery) state.today.stats.clinicCancellations++;
      waiting.push(r);
      continue;
    }
    diary.next = Math.max(diary.next, b.at + b.mins * TICKS_PER_MINUTE);
  }
  if (waiting.length === 0) return;

  const bySpecialty = new Map<string, Diary[]>();
  for (const d of sessions.values()) {
    const k = `${d.specialty}:${d.theatre}`;
    if (!bySpecialty.has(k)) bySpecialty.set(k, []);
    bySpecialty.get(k)!.push(d);
  }
  for (const list of bySpecialty.values()) list.sort((a, b) => a.start - b.start);

  // Nothing is booked for today, or before the referral is a day old.
  const tomorrow = tickAt(today + 1, 0);
  for (const r of waiting.sort(bookingOrder)) {
    const list = bySpecialty.get(`${r.specialty}:${r.kind === "surgery"}`);
    const mins = slotMins(r);
    if (!list || mins === null) continue;
    const earliest =
      r.kind === "follow_up"
        ? Math.max(tomorrow, r.due! - FOLLOW_UP_EARLY_DAYS * TICKS_PER_DAY)
        : tomorrow;
    const diary = list.find(
      (d) =>
        canBook(state, r, d) && d.start >= earliest && d.next + mins * TICKS_PER_MINUTE <= d.end,
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
