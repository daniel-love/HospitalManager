/**
 * Recommendations for the Help panel: a checklist of what a working hospital
 * needs, ticked off against the current layout and staff, and a rough guide
 * to how many cubicles, bays and staff the catchment's demand calls for.
 * Pure functions of SimState, like describe.ts.
 */
import { content, specialtyById } from "@data/catalogue";
import {
  ARRIVALS_BY_HOUR,
  BOOKING_MINS,
  CUBICLE_CLEAN_MINS,
  HANDOVER_MINS,
  TRIAGE_MINS,
} from "@data/patients";
import type { ConditionDef, SpecialtyId, StaffRoleId } from "@data/schema";
import { missingRoom, roomsPatientsCantReach } from "@sim/places";
import type { SimState } from "@sim/state";
import { parkingSpaces } from "@sim/systems/ambulances";
import { dailyDemand } from "@sim/systems/arrivals";
import { monitorsCovering, observedBeds, stationsSeeing } from "@sim/systems/monitoring";

export type AdviceStatus = "ok" | "todo" | "optional";

export interface AdviceItem {
  status: AdviceStatus;
  text: string;
  /** Why it matters, or what's wrong now. */
  detail: string;
}

export interface AdviceGroup {
  heading: string;
  /** One line on what this part of the hospital is for. */
  intro: string;
  items: AdviceItem[];
}

export interface CapacityRow {
  label: string;
  have: number;
  /** null when it can't be worked out yet (e.g. nothing arrives by that route). */
  recommended: number | null;
  note: string;
}

export interface AdviceData {
  groups: AdviceGroup[];
  /** The first thing still to do, for the top of the panel. */
  next: AdviceItem | null;
  demand: { walkIns: number; ambulances: number; catchment: number };
  capacity: CapacityRow[];
}

/**
 * Planning assumptions for the capacity guide. A patient keeps their cubicle
 * or trolley while they wait between steps, not just during them, and the
 * busiest hour of the day sees about 1.5× the average arrivals.
 */
export const PLANNING = {
  /** Time in a room ÷ time being treated in it. */
  occupancyPerTreatment: 2,
  /** Highest share of the time a room or person should be busy at the peak. */
  roomUtilisation: 0.85,
  staffUtilisation: 0.75,
  /** Nurse-to-trolley ratio in Majors (RCN guidance: 1 to 4), and Resus (1 to 2). */
  majorsBedsPerNurse: 4,
  resusBedsPerNurse: 2,
  /** Rule of thumb: one cleaner per this many cubicles, trolleys and ward beds. */
  bedsPerCleaner: 15,
};

const PEAK_FACTOR =
  Math.max(...ARRIVALS_BY_HOUR) / (ARRIVALS_BY_HOUR.reduce((a, b) => a + b, 0) / 24);
const mean = ([a, b]: readonly [number, number]) => (a + b) / 2;
const MINS_PER_DAY = 24 * 60;

export function describeAdvice(state: SimState): AdviceData {
  const staffCount = (role: StaffRoleId) =>
    Object.values(state.staff).filter((s) => s.role === role).length;
  const has = (role: StaffRoleId) => staffCount(role) > 0;
  const rooms = (type: string) => state.rooms.filter((r) => r.valid && r.typeId === type);
  const hasRoom = (type: string) => rooms(type).length > 0;
  const item = (done: boolean, text: string, detail: string, optional = false): AdviceItem => ({
    status: done ? "ok" : optional ? "optional" : "todo",
    text,
    detail,
  });

  const unreachable = roomsPatientsCantReach(state);
  const essentials: AdviceGroup = {
    heading: "Walk-in A&E",
    intro: "The minimum to see minor injuries and illnesses: book in, triage, treat.",
    items: [
      item(
        hasRoom("ae_reception"),
        "A&E Reception, opening onto a Waiting Area",
        "Every walk-in queues at the reception desk to book in.",
      ),
      item(
        has("receptionist"),
        "A receptionist",
        "Without one, the queue at the desk never moves.",
      ),
      item(
        hasRoom("waiting_area"),
        "A Waiting Area with seats",
        "Patients wait here for triage and treatment. Standing makes them unhappy sooner.",
      ),
      item(
        hasRoom("triage_room"),
        "A Triage Room",
        "A nurse sorts every patient by urgency (Manchester Triage) before treatment.",
      ),
      item(has("nurse"), "Staff nurses", "They triage, do nursing steps and take observations."),
      item(
        hasRoom("minors_cubicle"),
        "Minors Cubicles",
        "Where minor injuries and illnesses are treated.",
      ),
      item(
        has("junior_doctor"),
        "Junior doctors",
        "Illnesses need a doctor, and doctors lead resuscitation.",
      ),
      item(
        has("nurse_practitioner"),
        "An Emergency Nurse Practitioner",
        "Sees minor injuries start to finish, keeping doctors free for illnesses.",
        true,
      ),
      item(
        hasRoom("toilets"),
        "Toilets near the waiting area",
        "Waiting patients need them, and get unhappy queueing for one.",
      ),
      item(has("cleaner"), "A cleaner", "A dirty cubicle or trolley can't take the next patient."),
      item(
        unreachable.length === 0,
        "Every room reachable from a corridor",
        unreachable.length === 0
          ? "Patients don't walk through one clinical room to reach another."
          : `${unreachable.length === 1 ? "A room is" : `${unreachable.length} rooms are`} only reachable through another clinical room. Add a door onto a corridor.`,
      ),
    ],
  };

  // Majors: the room must exist, and have the equipment its conditions need.
  const majorsGaps = new Set<string>();
  for (const c of content.conditions) {
    for (const step of c.pathway) {
      if (step.room !== "majors_bay") continue;
      const why = missingRoom(state, step.room, step.capabilities);
      if (why && hasRoom("majors_bay")) majorsGaps.add(why);
    }
  }
  const beds = observedBeds(state);
  const seeing = stationsSeeing(state);
  const remote = monitorsCovering(state);
  const blind = beds.filter(
    (b) => (seeing.get(b.id) ?? []).length + (remote.get(b.id) ?? []).length === 0,
  ).length;
  const spaces = parkingSpaces(state).length;
  const majors: AdviceGroup = {
    heading: "Ambulances, Majors and Resus",
    intro: "Seriously ill patients arrive by ambulance, and only to an A&E that can take them.",
    items: [
      item(
        spaces > 0,
        "An Ambulance Bay ambulances can drive to",
        hasRoom("ambulance_bay") && spaces === 0
          ? "The bay has no clear 3×6 space an ambulance can reach from the road."
          : "Without one, no ambulances come.",
      ),
      item(
        hasRoom("majors_bay") && majorsGaps.size === 0,
        "Majors Bays with the right equipment",
        majorsGaps.size > 0
          ? `${[...majorsGaps].join(". ")}.`
          : "Chest pain, breathlessness, sepsis and falls need a trolley, a monitor and oxygen.",
      ),
      item(
        beds.length > 0 && blind === 0,
        "Every Majors and Resus trolley in sight of a nurse station",
        blind > 0
          ? `${blind} ${blind === 1 ? "trolley isn't" : "trolleys aren't"} seen by any station. Press O to see coverage.`
          : "A watching nurse spots deterioration before the patient collapses.",
      ),
      item(
        hasRoom("resus_bay"),
        "A Resus Bay near the ambulance entrance",
        "For cardiac arrests and the sickest arrivals, such as anaphylaxis and septic shock.",
      ),
    ],
  };

  // Which specialties are needed: those of conditions this hospital can treat.
  const needed = new Map<SpecialtyId, string[]>();
  for (const c of content.conditions) {
    const sp = admittingSpecialty(c);
    if (!sp) continue;
    needed.set(sp, [...(needed.get(sp) ?? []), c.name.toLowerCase()]);
  }
  const teamOf = (sp: SpecialtyId) => Object.values(state.staff).filter((s) => s.specialty === sp);
  const admissions: AdviceGroup = {
    heading: "Admissions",
    intro:
      "Patients too unwell to go home are referred to a specialty team, admitted and wheeled up to a ward. Without these, they're transferred to another hospital.",
    items: [
      item(hasRoom("ward"), "A Ward", "Admitted patients stay for a day or more."),
      item(
        has("porter"),
        "Porters",
        "They wheel admitted patients to the ward on their bed: double doors and 2-wide corridors all the way.",
      ),
      ...[...needed].map(([sp, conds]) => {
        const team = teamOf(sp);
        const name = specialtyById.get(sp)!.name;
        return item(
          team.length > 0,
          `A ${name} team`,
          team.length > 0
            ? `${team.length} on staff. Takes ${listOf(conds)}.`
            : `A registrar or consultant to review and admit ${listOf(conds)}.`,
        );
      }),
      item(
        hasRoom("side_room"),
        "A Side Room off the ward",
        "Patients at the end of their life should have privacy; dying in an open bay brings complaints.",
        true,
      ),
    ],
  };

  const diagnostics: AdviceGroup = {
    heading: "Diagnostics",
    intro:
      "Most patients need blood tests or an X-ray before a decision. Without them, they're transferred to another hospital.",
    items: [
      item(
        hasRoom("lab"),
        "A Pathology Lab with a blood analyser",
        "Chest pain, abdominal pain, sepsis, breathlessness and falls all need blood results.",
      ),
      item(
        has("biomedical_scientist"),
        "A biomedical scientist",
        "Processes the samples; results follow when the analyser has run.",
      ),
      item(
        has("porter"),
        "Porters to take samples to the lab",
        "Without one, samples never reach the lab.",
      ),
      item(
        hasRoom("xray_room"),
        "An X-ray Room (lead-lined walls)",
        "For suspected fractures and chest X-rays.",
      ),
      item(has("radiographer"), "A radiographer", "Takes X-rays and does CT scans."),
      item(
        hasRoom("ct_room"),
        "A CT Room near A&E (lead-lined walls)",
        "For head injuries and falls that need a CT head (NICE: within an hour). Expensive, but without one those patients are transferred.",
        true,
      ),
    ],
  };

  const examiners = Object.values(state.staff).filter((s) => s.meDuty).length;
  const afterDeath: AdviceGroup = {
    heading: "When a patient dies",
    intro: "Deaths follow the full UK process: verification, family, Medical Examiner, release.",
    items: [
      item(
        hasRoom("relatives_room"),
        "A Relatives' Room",
        "Somewhere private to break bad news. Without one, families hear it in a corridor.",
      ),
      item(
        hasRoom("mortuary"),
        "A Mortuary",
        "With fridge space, away from public areas, on a bed-width route from A&E and the wards.",
      ),
      item(
        examiners > 0,
        "A consultant with the Medical Examiner duty",
        "Every death is reviewed before the death certificate. Give a resident consultant the duty in their inspector.",
      ),
    ],
  };

  const groups = [essentials, diagnostics, majors, admissions, afterDeath];
  const next = groups.flatMap((g) => g.items).find((i) => i.status === "todo") ?? null;
  const demand = dailyDemand(state);
  return {
    groups,
    next,
    demand: {
      walkIns: Math.round(demand.walkIns),
      ambulances: Math.round(demand.ambulances),
      catchment: state.settings.catchment,
    },
    capacity: capacityGuide(state, demand),
  };
}

/** The specialty a condition's patients may be referred or admitted to, if any. */
function admittingSpecialty(c: ConditionDef): SpecialtyId | undefined {
  if (c.admission) return c.specialty;
  return c.pathway.find((s) => s.specialty)?.specialty;
}

function listOf(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * How many rooms and staff the catchment's full demand needs at the busiest
 * time of day, from the conditions' pathways: patients a day × minutes each,
 * spread over the day, scaled up to the peak and down to a safe utilisation.
 * A rough guide: it ignores queues, deterioration and admissions.
 */
export function capacityGuide(
  state: SimState,
  demand: { walkIns: number; ambulances: number },
): CapacityRow[] {
  const perDay = new Map<ConditionDef, number>();
  for (const ch of ["walk_in", "ambulance"] as const) {
    const total = content.conditions.reduce((n, c) => n + c.channels[ch], 0);
    const arrivals = ch === "walk_in" ? demand.walkIns : demand.ambulances;
    for (const c of content.conditions) {
      if (total > 0) perDay.set(c, (perDay.get(c) ?? 0) + (arrivals * c.channels[ch]) / total);
    }
  }

  const roomMins = new Map<string, number>();
  const roleMins = new Map<StaffRoleId, number>();
  const add = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const [c, n] of perDay) {
    for (const step of c.pathway) {
      const mins = mean(step.mins) * n;
      add(roomMins, step.room, mins * PLANNING.occupancyPerTreatment);
      // The first role listed is who does it when free; injuries go to nurse practitioners.
      add(roleMins, step.roles[0]!, mins);
    }
    if (c.pathway[0]?.room === "minors_cubicle") {
      add(roomMins, "minors_cubicle", mean(CUBICLE_CLEAN_MINS) * n);
    }
  }
  add(
    roleMins,
    "nurse",
    demand.walkIns * mean(TRIAGE_MINS) + demand.ambulances * mean(HANDOVER_MINS),
  );
  add(roleMins, "receptionist", demand.walkIns * mean(BOOKING_MINS));

  const atPeak = (mins: number, utilisation: number) =>
    Math.ceil((mins * PEAK_FACTOR) / MINS_PER_DAY / utilisation);
  const rooms = (type: string) => atPeak(roomMins.get(type) ?? 0, PLANNING.roomUtilisation);
  const people = (role: StaffRoleId) => atPeak(roleMins.get(role) ?? 0, PLANNING.staffUtilisation);
  const count = (role: StaffRoleId) =>
    Object.values(state.staff).filter((s) => s.role === role).length;
  const valid = (type: string) => state.rooms.filter((r) => r.valid && r.typeId === type).length;

  const majorsBays = Math.max(1, rooms("majors_bay"));
  const resusBays = Math.max(1, rooms("resus_bay"));
  const wardBeds = state.rooms
    .filter((r) => r.valid && (r.typeId === "ward" || r.typeId === "side_room"))
    .reduce((n, r) => n + r.objectIds.filter((id) => isBed(state, id)).length, 0);
  const minors = Math.max(1, rooms("minors_cubicle"));
  // Watching Majors and Resus is on top of the nursing steps.
  const nurses =
    people("nurse") +
    Math.ceil(majorsBays / PLANNING.majorsBedsPerNurse) +
    Math.ceil(resusBays / PLANNING.resusBedsPerNurse);

  return [
    {
      label: "Minors Cubicles",
      have: valid("minors_cubicle"),
      recommended: minors,
      note: "Patients keep the cubicle between steps, and it's cleaned after.",
    },
    {
      label: "Majors Bays",
      have: valid("majors_bay"),
      recommended: majorsBays,
      note: "Majors patients stay on their trolley for hours.",
    },
    {
      label: "Resus Bays",
      have: valid("resus_bay"),
      recommended: resusBays,
      note: "Always keep one free for the next arrest.",
    },
    {
      label: "Receptionists",
      have: count("receptionist"),
      recommended: Math.max(1, people("receptionist")),
      note: "One per desk at the busiest time.",
    },
    {
      label: "Staff nurses",
      have: count("nurse"),
      recommended: Math.max(1, nurses),
      note: `Triage, handovers and nursing steps, plus 1 per ${PLANNING.majorsBedsPerNurse} Majors trolleys and 1 per ${PLANNING.resusBedsPerNurse} Resus trolleys.`,
    },
    {
      label: "Junior doctors",
      have: count("junior_doctor"),
      recommended: Math.max(1, people("junior_doctor")),
      note: "Assessing and reviewing every illness, and Majors and Resus patients.",
    },
    {
      label: "Nurse practitioners",
      have: count("nurse_practitioner"),
      recommended: people("nurse_practitioner"),
      note: "Minor injuries. Without them, the doctors see these too.",
    },
    {
      label: "Cleaners",
      have: count("cleaner"),
      recommended: Math.max(
        1,
        Math.ceil((minors + majorsBays + resusBays + wardBeds) / PLANNING.bedsPerCleaner),
      ),
      note: `About 1 per ${PLANNING.bedsPerCleaner} cubicles, trolleys and ward beds.`,
    },
  ];
}

function isBed(state: SimState, id: number): boolean {
  const defId = state.objects[id]?.defId;
  return defId === "hospital_bed" || defId === "profiling_bed";
}
