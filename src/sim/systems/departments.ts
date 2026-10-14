/**
 * Department statuses (GAME_DESIGN §8.3): a crisis lever. Taking a
 * department less than fully open relieves pressure at once, but costs
 * income (A&E's share of the block contract, or planned care's tariff) and
 * reputation every day it lasts (systems/reputation.ts statusPenalty). The
 * effects themselves live where the work happens: arrivals.ts (A&E),
 * referrals.ts and clinics.ts (outpatients), theatres.ts (theatres), and
 * funding.ts (the block).
 */
import type { Departments, SimState } from "../state";
import { emit } from "../events";
import { bookAppointments } from "./referrals";

export type Department = keyof Departments;

/** What each status means, for notifications and the Hospital dialog. */
export const STATUS_TEXT: {
  [D in Department]: Record<Departments[D], { label: string; effect: string }>;
} = {
  ae: {
    open: { label: "Open", effect: "Taking walk-ins and ambulances." },
    divert: {
      label: "Divert",
      effect:
        "Ambulances go to other hospitals; walk-ins still come. The block contract loses its ambulance share, and reputation falls each day.",
    },
    closed: {
      label: "Closed",
      effect:
        "Nobody comes: patients go to other hospitals. The block contract stops, and reputation falls fast each day.",
    },
  },
  outpatients: {
    open: { label: "Open", effect: "Taking every GP referral." },
    urgent: {
      label: "Urgent only",
      effect:
        "GPs send routine referrals elsewhere; urgent ones and patients already waiting are still seen. Reputation falls a little each day.",
    },
    closed: {
      label: "Closed",
      effect:
        "No clinics: booked appointments are cancelled and rebooked for when it reopens, and no new referrals come. Reputation falls each day.",
    },
  },
  theatres: {
    open: { label: "Open", effect: "Planned lists and emergencies." },
    emergency: {
      label: "Emergencies only",
      effect:
        "Planned lists stand down and their patients are cancelled and rebooked, freeing beds and staff for emergencies. Reputation falls a little each day.",
    },
    closed: {
      label: "Closed",
      effect:
        "No operations: patients needing emergency surgery are transferred out. Reputation falls each day.",
    },
  },
};

const NAMES: Record<Department, string> = {
  ae: "A&E",
  outpatients: "Outpatients",
  theatres: "Theatres",
};

/** Sets a department's status, and rebooks anything it affects. */
export function setDepartment<D extends Department>(
  state: SimState,
  dept: D,
  status: Departments[D],
): void {
  if (state.departments[dept] === status) return;
  state.departments[dept] = status;
  // Clinics and lists that won't run now have their bookings cancelled and rebooked.
  bookAppointments(state);
  const text = (STATUS_TEXT[dept] as Record<string, { label: string; effect: string }>)[status]!;
  emit(
    state,
    `${NAMES[dept]}: ${text.label.toLowerCase()}. ${text.effect}`,
    status === "open" ? "info" : "warn",
  );
}
