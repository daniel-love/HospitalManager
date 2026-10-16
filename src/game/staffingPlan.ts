/**
 * The staffing plan, for the Staff screen's Rota tab and the Help panel's
 * capacity guide: how many of each rota group the hospital needs on a day
 * shift and on a night shift, from the patients it can expect, how many
 * people that cover takes on three shifts a week, and what it costs.
 *
 * A&E work is spread over the day as patients arrive (ARRIVALS_BY_HOUR) and
 * planned for the busiest hour of each shift at a safe utilisation. Ward
 * nursing goes by beds, theatres by the theatres built, and some posts are
 * one per shift whatever the demand (a nurse in charge, a registrar for each
 * admitting specialty). A rough guide: it ignores queues and deterioration.
 * Pure functions of SimState, like describe.ts.
 */
import { content, staffRoleById } from "@data/catalogue";
import { ARRIVALS_BY_HOUR, BOOKING_MINS, HANDOVER_MINS, TRIAGE_MINS } from "@data/patients";
import { LAB_PROCESS_MINS } from "@data/diagnostics";
import type { ConditionDef, SpecialtyId, StaffRoleId } from "@data/schema";
import { pressureEventById } from "@data/pressure";
import { AGENCY, BANK, NURSE_BANDS, SHIFTS, SICKNESS, UNSOCIAL, type NurseBand } from "@data/staff";
import type { Cover, SimState } from "@sim/state";
import { dailyDemand, treatableConditions, treatableShare } from "@sim/systems/arrivals";
import { unsocialRate } from "@sim/systems/finance";
import { arrivalFactor } from "@sim/systems/pressure";
import { coverFor, groupName, rotaGroup, SLOTS } from "@sim/systems/rota";
import { groupMember } from "@sim/systems/workforce";
import { PRACTITIONERS } from "@sim/systems/theatres";

/** Planning assumptions: judgement calls, roughly in line with UK practice. */
export const STAFFING = {
  /** Highest share of the busiest hour someone should be busy. */
  utilisation: 0.75,
  /** Nurse-to-trolley ratio in Majors (RCN guidance: 1 to 4), and Resus (1 to 2). */
  majorsBedsPerNurse: 4,
  resusBedsPerNurse: 2,
  /** Ward beds per registered nurse by day (UK safe staffing: no more than 8) and at night. */
  wardBedsPerNurseDay: 8,
  wardBedsPerNurseNight: 10,
  /** One cleaner per this many cubicles, trolleys and ward beds by day; half that at night. */
  bedsPerCleaner: 15,
  /** A porter's minutes per admission (bed to the ward), sample to the lab, and escort to a scan and back. */
  porterAdmitMins: 20,
  porterSampleMins: 10,
  porterEscortMins: 25,
};

const mean = ([a, b]: readonly [number, number]) => (a + b) / 2;
const HOURS_TOTAL = ARRIVALS_BY_HOUR.reduce((a, b) => a + b, 0);
/** The clock hours each shift covers (a long day 07:30–20:00, a night 19:30–08:00). */
const DAY_HOURS = [...Array(24).keys()].filter((h) => h >= 8 && h < 20);
const NIGHT_HOURS = [...Array(24).keys()].filter((h) => h < 8 || h >= 20);
const busiest = (hours: number[]) => Math.max(...hours.map((h) => ARRIVALS_BY_HOUR[h]!));
const share = (hours: number[]) =>
  hours.reduce((n, h) => n + ARRIVALS_BY_HOUR[h]!, 0) / HOURS_TOTAL;

export interface PlanDemand {
  catchment: number;
  /** The catchment's emergency patients a day, by route (with any pressure event's extra). */
  walkIns: number;
  ambulances: number;
  /** Those who come here: with conditions the hospital can treat (and some it can't). */
  hereWalkIns: number;
  hereAmbulances: number;
  /** Patients arriving here during day shifts and night shifts, a day. */
  dayArrivals: number;
  nightArrivals: number;
  /** The busiest hour (0–23) and how many arrive in it. */
  peakHour: number;
  peakArrivals: number;
  /** Emergency admissions a day, from those arriving here. */
  admissions: number;
  wardBeds: number;
  theatres: number;
  /** A pressure event bringing more patients, e.g. "Winter surge". */
  surge: string | null;
}

export interface GroupPlan {
  /** Rota group: "porter", "nurse:band5", "registrar:cardiology". */
  key: string;
  name: string;
  role: StaffRoleId;
  band: NurseBand | null;
  specialty: SpecialtyId | null;
  /** Wanted on each day and night shift, from demand. */
  suggested: Cover;
  /** Where the suggestion comes from. */
  why: string;
  /** Useful but not needed for the hospital to work. */
  optional: boolean;
}

export interface StaffingPlan {
  demand: PlanDemand;
  groups: GroupPlan[];
}

/** People a cover takes: its shifts a week over three each. */
export function peopleFor(cover: Cover): number {
  return Math.ceil(((cover.day + cover.night) * SLOTS) / 2 / SHIFTS.perWeek);
}

/** A group member's pay a year with on-costs, before unsocial hours. */
export function groupPay(key: string): number {
  const m = groupMember(key);
  if (m.role === "nurse") return NURSE_BANDS.find((b) => b.band === m.band)!.annualCost;
  return staffRoleById.get(m.role)?.annualCost ?? 0;
}

/** The average unsocial hours enhancement over a day shift and a night shift, in the week. */
function unsocialShare(night: boolean): number {
  const start = night ? SHIFTS.nightStart : SHIFTS.dayStart;
  let total = 0;
  let steps = 0;
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let m = 0; m < SHIFTS.lengthMins; m += 30) {
      const at = start + m;
      total += unsocialRate((weekday + Math.floor(at / 1440)) % 7, Math.floor(at / 60) % 24);
      steps++;
    }
  }
  return total / steps;
}
const UNSOCIAL_DAY = unsocialShare(false);
const UNSOCIAL_NIGHT = unsocialShare(true);
const SHIFT_HOURS = SHIFTS.lengthMins / 60;
const WEEKS = UNSOCIAL.hoursPerYear / 37.5;

/** Basic pay for one shift of a group's, £. */
function shiftBasic(key: string): number {
  return (groupPay(key) / UNSOCIAL.hoursPerYear) * SHIFT_HOURS;
}

/** What a cover costs a year: the people's salaries, and unsocial hours on its shifts. */
export function coverCost(key: string, cover: Cover): { salaries: number; unsocial: number } {
  const basic = shiftBasic(key);
  return {
    salaries: peopleFor(cover) * groupPay(key),
    unsocial: 7 * WEEKS * basic * (cover.day * UNSOCIAL_DAY + cover.night * UNSOCIAL_NIGHT),
  };
}

/**
 * Filling a number of shifts a week from the bank (same pay as your own
 * staff, but only about two in three found) or an agency (always found, at
 * about twice the cost), a year, £. Shifts split in the cover's proportion.
 */
export function gapCost(key: string, cover: Cover, shifts: number) {
  const total = cover.day + cover.night;
  const nightShare = total > 0 ? cover.night / total : 0;
  const perShift =
    shiftBasic(key) * (1 + (1 - nightShare) * UNSOCIAL_DAY + nightShare * UNSOCIAL_NIGHT);
  return {
    bank: shifts * WEEKS * perShift * BANK.payFactor,
    agency: shifts * WEEKS * perShift * AGENCY.payFactor,
    bankFills: BANK.fillChance,
    /** The unsocial hours on those shifts, which your own staff are paid too. */
    unsocial: shifts * WEEKS * (perShift - shiftBasic(key)),
  };
}

/** Shifts a week a cover can expect to lose to sickness (the usual rate, before low morale). */
export function sickShifts(cover: Cover): number {
  return (cover.day + cover.night) * 7 * SICKNESS.base;
}

/** The specialty a condition's patients may be referred or admitted to, if any. */
export function admittingSpecialty(c: ConditionDef): SpecialtyId | undefined {
  if (c.admission) return c.specialty;
  return c.pathway.find((s) => s.specialty)?.specialty;
}

/** Arrivals a day of each condition the hospital can treat, with any pressure event's extra. */
function arrivalsHere(state: SimState): Map<ConditionDef, number> {
  const demand = dailyDemand(state);
  const treatable = treatableConditions(state);
  const out = new Map<ConditionDef, number>();
  if (state.funding === "private") return out;
  for (const ch of ["walk_in", "ambulance"] as const) {
    const all = content.conditions.reduce((n, c) => n + c.channels[ch], 0);
    const perDay =
      (ch === "walk_in" ? demand.walkIns : demand.ambulances) * arrivalFactor(state, ch);
    for (const c of treatable) {
      if (all > 0) out.set(c, (out.get(c) ?? 0) + (perDay * c.channels[ch]) / all);
    }
  }
  return out;
}

export function staffingPlan(state: SimState): StaffingPlan {
  const rooms = (type: string) => state.rooms.filter((r) => r.valid && r.typeId === type);
  const count = (type: string) => rooms(type).length;
  const wardBeds = state.rooms
    .filter((r) => r.valid && (r.typeId === "ward" || r.typeId === "side_room"))
    .reduce((n, r) => n + r.objectIds.filter((id) => isBed(state, id)).length, 0);
  const theatres = count("theatre");
  const privateHospital = state.funding === "private";

  // A&E work in minutes a day, by role, as patients arrive.
  const here = arrivalsHere(state);
  const mins = new Map<StaffRoleId, number>();
  const add = (role: StaffRoleId, m: number) => mins.set(role, (mins.get(role) ?? 0) + m);
  let admissions = 0;
  for (const [c, n] of here) {
    const majors = c.pathway[0]?.room === "majors_bay" || c.pathway[0]?.room === "resus_bay";
    for (const step of c.pathway) {
      const k = n * step.chance;
      // The first role listed is who does it when free; injuries go to nurse practitioners.
      add(step.roles[0]!, mean(step.mins) * k);
      if (step.sample) {
        add("biomedical_scientist", mean(LAB_PROCESS_MINS) * k);
        add("porter", STAFFING.porterSampleMins * k);
      }
      if (step.imaging && majors) add("porter", STAFFING.porterEscortMins * k);
    }
    if (c.admission) {
      admissions += n * c.admission.chance;
      add("porter", STAFFING.porterAdmitMins * n * c.admission.chance);
    }
  }
  const demand = dailyDemand(state);
  const surge =
    arrivalFactor(state, "walk_in") > 1 || arrivalFactor(state, "ambulance") > 1
      ? (state.pressure.active.map((e) => pressureEventById.get(e.defId)?.name).find(Boolean) ??
        null)
      : null;
  const hereWalkIns = privateHospital
    ? 0
    : demand.walkIns * treatableShare(state, "walk_in") * arrivalFactor(state, "walk_in");
  const hereAmbulances = privateHospital
    ? 0
    : demand.ambulances * treatableShare(state, "ambulance") * arrivalFactor(state, "ambulance");
  add("nurse", hereWalkIns * mean(TRIAGE_MINS) + hereAmbulances * mean(HANDOVER_MINS));
  add("receptionist", hereWalkIns * mean(BOOKING_MINS));

  /** People at once for a role's A&E work in a shift's busiest hour. */
  const forArrivals = (role: StaffRoleId, night: boolean) => {
    const m = mins.get(role) ?? 0;
    if (m <= 0) return 0;
    const peakMins = (m * busiest(night ? NIGHT_HOURS : DAY_HOURS)) / HOURS_TOTAL;
    return Math.ceil(peakMins / 60 / STAFFING.utilisation);
  };
  const both = (f: (night: boolean) => number): Cover => ({ day: f(false), night: f(true) });
  const atLeast = (n: number, c: Cover): Cover => ({
    day: Math.max(n, c.day),
    night: Math.max(n, c.night),
  });

  const groups: GroupPlan[] = [];
  const push = (key: string, suggested: Cover, why: string, optional = false) => {
    if (suggested.day + suggested.night === 0) return;
    groups.push({ key, name: groupName(key), ...groupMember(key), suggested, why, optional });
  };
  const ae = here.size > 0;

  // Nurses: A&E steps and triage, watching Majors and Resus trolleys, the wards, Recovery.
  const majorsWatch =
    Math.ceil(count("majors_bay") / STAFFING.majorsBedsPerNurse) +
    Math.ceil(count("resus_bay") / STAFFING.resusBedsPerNurse);
  const recovery = theatres > 0 ? count("recovery") : 0;
  const nurses = both((night) => {
    const ward = Math.ceil(
      wardBeds / (night ? STAFFING.wardBedsPerNurseNight : STAFFING.wardBedsPerNurseDay),
    );
    return forArrivals("nurse", night) + majorsWatch + ward + (night ? 0 : recovery);
  });
  const nurseParts = [
    ae && "triage, handovers and nursing steps",
    majorsWatch > 0 &&
      `1 per ${STAFFING.majorsBedsPerNurse} Majors and ${STAFFING.resusBedsPerNurse} Resus trolleys`,
    wardBeds > 0 &&
      `1 per ${STAFFING.wardBedsPerNurseDay} ward beds by day and ${STAFFING.wardBedsPerNurseNight} at night`,
    recovery > 0 && "Recovery by day",
  ].filter(Boolean);
  if (nurses.day + nurses.night > 0) {
    // One Band 7 in charge of each shift; Band 6s as the player has them; the rest Band 5.
    const b6 = coverFor(state, "nurse:band6") ?? { day: 0, night: 0 };
    const b6Day = Math.min(b6.day, Math.max(0, nurses.day - 1));
    const b6Night = Math.min(b6.night, Math.max(0, nurses.night - 1));
    const total = `${nurses.day} nurses on a day shift and ${nurses.night} at night (${nurseParts.join("; ")})`;
    push(
      "nurse:band7",
      { day: 1, night: 1 },
      "A nurse in charge of every shift: all nurses work about 10% faster.",
    );
    push(
      "nurse:band6",
      { day: b6Day, night: b6Night },
      "Your choice: about 5% quicker than Band 5, for 22% more pay.",
      true,
    );
    push(
      "nurse:band5",
      { day: Math.max(0, nurses.day - 1 - b6Day), night: Math.max(0, nurses.night - 1 - b6Night) },
      `The rest of ${total}.`,
    );
  }

  if (ae) {
    push(
      "junior_doctor",
      atLeast(
        1,
        both((n) => forArrivals("junior_doctor", n)),
      ),
      "Assessing and treating illnesses and Majors patients, at the busiest hour of each shift. At least one at all times.",
    );
    push(
      "nurse_practitioner",
      both((n) => forArrivals("nurse_practitioner", n)),
      "Minor injuries at the busiest hour. Without them, the doctors see these too.",
      true,
    );
    push(
      "receptionist",
      atLeast(
        1,
        both(
          (n) =>
            forArrivals("receptionist", n) + (!n && count("outpatients_reception") > 0 ? 1 : 0),
        ),
      ),
      `Booking walk-ins in at A&E reception, round the clock${count("outpatients_reception") > 0 ? ", plus one at Outpatients Reception by day" : ""}.`,
    );
  } else if (privateHospital && wardBeds > 0) {
    push(
      "junior_doctor",
      { day: 1, night: 1 },
      "A resident medical officer looking after inpatients day and night.",
    );
  }
  if (!ae && count("outpatients_reception") > 0) {
    push("receptionist", { day: 1, night: 0 }, "Outpatients Reception, by day.");
  }

  // A registrar of each admitting specialty on every shift, to take A&E referrals.
  if (!privateHospital) {
    const specialties = new Set<SpecialtyId>();
    for (const c of here.keys()) {
      const sp = admittingSpecialty(c);
      if (sp) specialties.add(sp);
    }
    for (const s of Object.values(state.staff)) {
      const g = rotaGroup(s);
      if (g?.startsWith("registrar:") && s.specialty) specialties.add(s.specialty);
    }
    for (const sp of [...specialties].sort()) {
      push(
        `registrar:${sp}`,
        { day: 1, night: 1 },
        "One on every shift reviews A&E referrals straight away. Without one, out of hours the on-call consultant comes in from home (20 to 40 minutes). Registrars with clinics or lists work weekdays instead, off the rota.",
        true,
      );
    }
  }

  const hasLab = count("lab") > 0;
  const imaging = count("xray_room") + count("ct_room") > 0;
  if (imaging) {
    push(
      "radiographer",
      atLeast(
        1,
        both((n) => forArrivals("radiographer", n)),
      ),
      "X-rays and CT scans at the busiest hour; one round the clock for A&E.",
    );
  }
  if (hasLab) {
    push(
      "biomedical_scientist",
      atLeast(
        1,
        both((n) => forArrivals("biomedical_scientist", n)),
      ),
      "Booking in and loading blood samples; one round the clock for A&E.",
    );
  }
  if (wardBeds > 0 || hasLab || ae) {
    push(
      "porter",
      atLeast(
        1,
        both((n) => forArrivals("porter", n)),
      ),
      `Taking admissions to the wards (about ${Math.round(admissions)} a day), samples to the lab and Majors patients to scans.`,
    );
  }
  if (theatres > 0) {
    push(
      "theatre_practitioner",
      { day: PRACTITIONERS * theatres, night: privateHospital ? 0 : PRACTITIONERS },
      privateHospital
        ? `${PRACTITIONERS} for each theatre by day.`
        : `${PRACTITIONERS} for each theatre by day, and ${PRACTITIONERS} at night for emergency operations.`,
    );
  }
  const beds = count("minors_cubicle") + count("majors_bay") + count("resus_bay") + wardBeds;
  if (beds > 0) {
    const day = Math.max(1, Math.ceil(beds / STAFFING.bedsPerCleaner));
    push(
      "cleaner",
      { day, night: Math.ceil(day / 2) },
      `About 1 per ${STAFFING.bedsPerCleaner} cubicles, trolleys and ward beds by day (${beds} now), half that at night.`,
    );
  }
  if (state.settings.eventFrequency !== "off" && state.rooms.some((r) => r.valid)) {
    push(
      "clinical_engineer",
      { day: 1, night: 0 },
      "Repairs and planned maintenance by day. Without one, broken kit stays out of service.",
      true,
    );
  }

  const peakHour = ARRIVALS_BY_HOUR.indexOf(Math.max(...ARRIVALS_BY_HOUR));
  const arrivals = hereWalkIns + hereAmbulances;
  return {
    demand: {
      catchment: state.settings.catchment,
      walkIns: demand.walkIns * arrivalFactor(state, "walk_in"),
      ambulances: demand.ambulances * arrivalFactor(state, "ambulance"),
      hereWalkIns,
      hereAmbulances,
      dayArrivals: arrivals * share(DAY_HOURS),
      nightArrivals: arrivals * share(NIGHT_HOURS),
      peakHour,
      peakArrivals: (arrivals * ARRIVALS_BY_HOUR[peakHour]!) / HOURS_TOTAL,
      admissions,
      wardBeds,
      theatres,
      surge,
    },
    groups,
  };
}

function isBed(state: SimState, id: number): boolean {
  const defId = state.objects[id]?.defId;
  return defId === "hospital_bed" || defId === "profiling_bed";
}
