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
import { holder, missingRoom, roomsPatientsCantReach } from "@sim/places";
import type { Funding, SimState } from "@sim/state";
import { parkingSpaces } from "@sim/systems/ambulances";
import { dailyDemand } from "@sim/systems/arrivals";
import { monitorsCovering, observedBeds, stationsSeeing } from "@sim/systems/monitoring";
import { outpatientDesks } from "@sim/systems/outpatients";
import { clinicDemandPerDay, offersClinic, offersPrivateClinic } from "@sim/systems/referrals";
import { PRIVATE } from "@data/economy";
import { dailyBlock } from "@sim/systems/funding";
import { formatMoney } from "./tools";
import { SLOTS } from "@sim/systems/rota";
import { operates, runsClinics } from "@sim/systems/staffing";
import { SHIFTS } from "@data/staff";
import { PRACTITIONERS, TURNAROUND_MINS } from "@sim/systems/theatres";
import { CLINIC_SESSIONS } from "@data/outpatients";

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
  funding: Funding;
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
        "Patients wait here for triage and treatment. Standing, or a crowded room, makes them unhappy sooner.",
      ),
      item(
        hasRoom("triage_room"),
        "A Triage Room",
        "A nurse sorts every patient by urgency (Manchester Triage) before treatment.",
      ),
      item(has("nurse"), "Staff nurses", "They triage, do nursing steps and take observations."),
      item(
        Object.values(state.staff).some((s) => s.role === "nurse" && s.band === 7),
        "A Band 7 charge nurse",
        "With one on duty the shift has a nurse in charge, and the nursing team works about 10% faster. Set Band 7 cover of 1 on days and nights for one every shift.",
        true,
      ),
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
    if (c.planned) continue;
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
        "For head injuries and falls that need a CT head (NCG: within an hour). Expensive, but without one those patients are transferred.",
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

  const staffAreas: AdviceGroup = {
    heading: "Staff areas",
    intro:
      "Between jobs, staff wait at a base in their own department, ready for the next one. Without their base they wait in the Staff Room, or, with no Staff Room, wherever their last job ended.",
    items: [
      item(
        hasRoom("staff_base"),
        "An A&E Staff Base with a desk",
        "Where doctors and nurse practitioners wait for the next patient. Central, near Minors and Majors.",
        true,
      ),
      item(
        hasRoom("doctors_office"),
        "A Doctors' Office with desks",
        "Where consultants and registrars do letters and discharge summaries between jobs, one per desk. Without one they wait on their ward.",
        true,
      ),
      item(
        hasRoom("porters_lodge"),
        "A Porters' Lodge",
        "Somewhere central keeps porters' walks to A&E, the wards and the lab short.",
        true,
      ),
      item(
        hasRoom("domestic_services_room"),
        "A Domestic Services Room",
        "The cleaners' base, with a sink.",
        true,
      ),
      item(
        hasRoom("staff_room"),
        "A Staff Room",
        "For breaks (from M5). Until then, anyone without a base waits here.",
        true,
      ),
    ],
  };

  // Outpatients is optional until the player starts on it; then it's a checklist.
  const clinicians = Object.values(state.staff).filter((s) => runsClinics(s));
  const sessions = clinicians.reduce((n, s) => n + s.clinicSessions, 0);
  const started = hasRoom("outpatients_reception") || hasRoom("outpatient_clinic") || sessions > 0;
  const deskStaffed = outpatientDesks(state).some(
    (d) => holder(state, d.id, "staff") !== undefined,
  );
  const outpatients: AdviceGroup = {
    heading: "Outpatients",
    intro:
      "GP referrals to specialty clinics: a business of its own, with booked appointments, follow-ups and the 18-week referral-to-treatment standard. GPs only refer while a specialty's clinics are running.",
    items: [
      item(
        hasRoom("outpatients_reception"),
        "Outpatients Reception, opening onto a Waiting Area",
        "Outpatients book in here, then wait to be called.",
        !started,
      ),
      item(
        deskStaffed,
        "A receptionist at its desk",
        "Receptionists fill A&E's desks first, so hire one more than A&E needs.",
        !started,
      ),
      item(
        hasRoom("outpatient_clinic"),
        "Outpatient Clinic Rooms (desk, couch, sink)",
        "Give each a specialty in its inspector, or leave it open to any. One room per clinic running at the same time.",
        !started,
      ),
      item(
        clinicians.some((s) => s.role === "consultant" && s.clinicSessions > 0),
        "A resident consultant with clinic sessions",
        "Set their weekly clinics in their inspector. Dermatology, ENT and Ophthalmology are mostly clinic work; Cardiology, General Surgery and Trauma & Orthopaedics also take A&E referrals.",
        !started,
      ),
    ],
  };

  // Theatres: optional until there's a theatre, a list, or patients waiting for surgery.
  const surgeons = Object.values(state.staff).filter((s) => operates(s));
  const lists = (anaesthetic: boolean) =>
    surgeons
      .filter((s) => (s.specialty === "anaesthetics") === anaesthetic)
      .reduce((n, s) => n + s.theatreSessions, 0);
  const waitingForSurgery = Object.values(state.referrals).some((r) => r.kind === "surgery");
  const theatreStarted =
    hasRoom("theatre") || hasRoom("recovery") || lists(false) > 0 || waitingForSurgery;
  const theatres: AdviceGroup = {
    heading: "Theatres",
    intro:
      "Planned operations for patients your clinics list for surgery, and emergency operations for patients admitted through A&E. Day cases go home the same day; the rest need a ward bed.",
    items: [
      item(
        hasRoom("theatre"),
        "An Operating Theatre (table, anaesthetic machine, light, scrub sink)",
        "On a bed-width route to Recovery, the wards and A&E. One per list running at once.",
        !theatreStarted,
      ),
      item(
        hasRoom("recovery"),
        "Recovery, next to the theatres",
        "A trolley, bedside monitor and oxygen for each patient coming round. Without a free one, the theatre can't take its next case.",
        !theatreStarted,
      ),
      item(
        hasRoom("day_surgery_unit"),
        "A Day Surgery Unit (a nurses' desk and seats)",
        "Planned patients are admitted here by a nurse on the day, and day cases rest here before going home.",
        !theatreStarted,
      ),
      item(
        lists(false) > 0,
        "Surgeons with theatre lists",
        "Set their weekly lists in their inspector. Only planned lists bring patients off the surgical waiting list.",
        !theatreStarted,
      ),
      item(
        lists(true) >= lists(false) && lists(true) > 0,
        "Anaesthetists covering every list",
        `Every list needs an anaesthetist: Anaesthetics consultants or registrars with theatre lists in their inspector (${lists(true)} of ${lists(false)} covered).`,
        !theatreStarted,
      ),
      item(
        staffCount("theatre_practitioner") >= PRACTITIONERS,
        "Two theatre practitioners per theatre in use",
        "Scrub nurses or ODPs. Without two free, an operation can't start.",
        !theatreStarted,
      ),
      item(
        state.rooms.some((r) => r.valid && r.typeId === "theatre" && r.emergency),
        "A theatre kept for emergencies",
        "Emergencies otherwise take the next slot on a planned list, cancelling someone's operation.",
        true,
      ),
    ],
  };

  const block = dailyBlock(state);
  const clinicsRunning = Object.values(state.staff).some(
    (s) => runsClinics(s) && s.clinicSessions > 0,
  );
  const money: AdviceGroup = {
    heading: "Paying your way",
    intro: `PHS money comes three ways. A block contract pays for the emergency care you're equipped to provide, sized to your rooms and ward beds and capped by what you actually deliver (worth ${formatMoney(block)} a day now). Each emergency patient earns 30% of their tariff on top, about what their drugs and supplies cost. Planned care, clinics and operations, is paid in full. A&E alone runs at a loss: admissions, clinics and theatres are what pay.`,
    items: [
      item(
        hasRoom("ward") && Object.values(state.staff).some((s) => s.role === "registrar"),
        "Wards, and doctors to admit to them",
        "Emergency admissions are most of the block's value: each ward bed adds to it, as long as A&E can get patients to it.",
        true,
      ),
      item(
        clinicsRunning,
        "Outpatient clinics",
        "Each appointment is paid in full, and clinics list patients for surgery.",
        true,
      ),
      item(
        lists(false) > 0,
        "Planned operations",
        "The best-paid work: a day case or planned stay is paid in full, and needs only a theatre list's time.",
        true,
      ),
    ],
  };

  const funding = state.funding;
  const staff = Object.values(state.staff);
  const privateClinics = staff.some((s) =>
    funding === "private"
      ? s.contract === "privileges" && s.clinicSessions > 0
      : s.privateClinicSessions > 0,
  );
  const privateLists = staff.some((s) =>
    funding === "private"
      ? s.contract === "privileges" && s.theatreSessions > 0 && s.specialty !== "anaesthetics"
      : s.privateTheatreSessions > 0 && s.specialty !== "anaesthetics",
  );
  const unit = (type: string) =>
    state.rooms.some((r) => r.valid && r.typeId === type && (funding === "private" || r.private));
  const privateCare: AdviceGroup = {
    heading: funding === "private" ? "Private hospital" : "Private Patient Unit",
    intro:
      funding === "private"
        ? `Insured and self-pay patients come for clinics and planned operations, as many as your reputation (${Math.round(state.reputation)}) and prices draw. You earn the facility fee; consultants bill their own. You can also take PHS patients who choose you, at tariff (Hospital → Policies).`
        : `Private patients in rooms set aside as the Private Patient Unit (in each room's inspector), seen in your consultants' private sessions on top of their PHS work. Private income can't pass ${Math.round(PRIVATE.incomeCap * 100)}% of all income.`,
    items: [
      item(
        funding === "private" ? hasRoom("outpatient_clinic") : unit("outpatient_clinic"),
        funding === "private"
          ? "Outpatient clinic rooms and Outpatients Reception"
          : "A clinic room in the Private Patient Unit",
        "Private patients' first appointments and follow-ups.",
      ),
      item(
        privateClinics,
        funding === "private"
          ? "Consultants with practising privileges and clinic sessions"
          : "Consultants with private clinic sessions",
        funding === "private"
          ? "Grant privileges in the Staff screen, then set their sessions in their inspector. They aren't paid by you, and come in only for their sessions."
          : "Set in a consultant's inspector, alongside their PHS job plan. They can't be in two places at once.",
      ),
      item(
        funding === "private" ? hasRoom("theatre") : unit("theatre"),
        funding === "private"
          ? "Theatres for private lists"
          : "A theatre in the Private Patient Unit",
        "Planned operations: day cases, and stays in a room of their own. Recovery and a Day Surgery Unit as for any theatre.",
        true,
      ),
      item(
        privateLists,
        "Surgeons with private theatre lists, and an anaesthetist for each",
        "The best-paid private work.",
        true,
      ),
      item(
        unit("side_room"),
        funding === "private"
          ? "Side rooms for inpatients"
          : "Side rooms in the Private Patient Unit",
        "A private inpatient has a room of their own: without a free one, their operation is cancelled on the day.",
        true,
      ),
      ...(funding === "private"
        ? [
            item(
              staffCount("junior_doctor") > 0,
              "A resident doctor on every shift",
              "A junior doctor looks after inpatients day and night, as a private hospital's resident medical officer does.",
              true,
            ),
          ]
        : []),
    ],
  };
  if (funding === "private") {
    money.intro = `A private hospital earns facility fees: insurers pay their negotiated rates, self-pay patients your prices (Hospital → Policies), and PHS patients who choose you pay tariff. There's no block contract, and no A&E. Consultants with practising privileges cost you nothing; nurses, theatre staff and the building do.`;
    money.items = money.items.filter((i) => i.text !== "Wards, and doctors to admit to them");
  }

  const groups =
    funding === "private"
      ? [privateCare, diagnostics, outpatients, theatres, afterDeath, staffAreas, money]
      : [
          essentials,
          diagnostics,
          majors,
          admissions,
          outpatients,
          theatres,
          ...(funding === "hybrid" ? [privateCare] : []),
          afterDeath,
          staffAreas,
          money,
        ];
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
    funding: state.funding,
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
  // A Private Hospital has no A&E: only its clinics and theatres to plan for.
  if (state.funding === "private") return [...clinicCapacity(state), ...theatreCapacity(state)];
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

  /**
   * A staff row: the guide works out how many are needed at work at once;
   * with rotas, each person works three shifts a week, so it takes about
   * 14 ÷ 3 times as many people to have that many on every shift.
   */
  const staffRow = (label: string, role: StaffRoleId, perShift: number, note: string) =>
    rotaRow(state, { label, have: count(role), recommended: perShift, note });

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
    staffRow(
      "Receptionists",
      "receptionist",
      Math.max(1, people("receptionist")),
      "One per desk at the busiest time.",
    ),
    staffRow(
      "Staff nurses",
      "nurse",
      Math.max(1, nurses),
      `Triage, handovers and nursing steps, plus 1 per ${PLANNING.majorsBedsPerNurse} Majors trolleys and 1 per ${PLANNING.resusBedsPerNurse} Resus trolleys.`,
    ),
    staffRow(
      "Junior doctors",
      "junior_doctor",
      Math.max(1, people("junior_doctor")),
      "Assessing and reviewing every illness, and Majors and Resus patients.",
    ),
    staffRow(
      "Nurse practitioners",
      "nurse_practitioner",
      people("nurse_practitioner"),
      "Minor injuries. Without them, the doctors see these too.",
    ),
    ...clinicCapacity(state),
    ...theatreCapacity(state),
    staffRow(
      "Cleaners",
      "cleaner",
      Math.max(
        1,
        Math.ceil((minors + majorsBays + resusBays + wardBeds) / PLANNING.bedsPerCleaner),
      ),
      `About 1 per ${PLANNING.bedsPerCleaner} cubicles, trolleys and ward beds.`,
    ),
  ];
}

/**
 * With rotas on, turns a row's people needed at once into people to hire,
 * saying how many that is on each shift.
 */
function rotaRow(state: SimState, row: CapacityRow): CapacityRow {
  const perShift = row.recommended;
  if (!state.settings.rotas || !perShift) return row;
  return {
    ...row,
    recommended: Math.ceil((perShift * SLOTS) / SHIFTS.perWeek),
    note: `${perShift} on each shift, day and night, takes about ${Math.ceil((perShift * SLOTS) / SHIFTS.perWeek)} people on three shifts a week. ${row.note}`,
  };
}

/**
 * Clinic sessions a week each specialty's GP demand needs: first
 * appointments plus their follow-ups (p / (1 − p) each), in booked minutes,
 * over a 4-hour session. Only for specialties with clinics running.
 */
function clinicCapacity(state: SimState): CapacityRow[] {
  const sessionMins = CLINIC_SESSIONS.am.end - CLINIC_SESSIONS.am.start;
  const rows: CapacityRow[] = [];
  for (const sp of content.specialties) {
    const o = sp.outpatients;
    if (!o || !(offersClinic(state, sp.id) || offersPrivateClinic(state, sp.id))) continue;
    const firsts = clinicDemandPerDay(state, sp.id) * 7;
    const followUps = o.followUpChance / (1 - o.followUpChance);
    const mins = firsts * (o.firstSlotMins + followUps * o.followUpSlotMins);
    const have = Object.values(state.staff)
      .filter((s) => s.specialty === sp.id && runsClinics(s))
      .reduce((n, s) => n + s.clinicSessions + s.privateClinicSessions, 0);
    rows.push({
      label: `${sp.name} clinics a week`,
      have,
      recommended: Math.ceil(mins / sessionMins),
      note: `About ${Math.round(firsts)} GP referrals a week, and ${followUps.toFixed(1)} follow-ups each. Fewer sessions and the waiting list grows.`,
    });
  }
  return rows;
}

/**
 * Theatre lists a week each specialty's clinics will fill: first
 * appointments × the share listed for surgery, at the average operation
 * plus turnaround, over a 4-hour list. Then anaesthetists to cover the
 * lists, and practitioners for the most lists at once.
 */
function theatreCapacity(state: SimState): CapacityRow[] {
  const listMins = CLINIC_SESSIONS.am.end - CLINIC_SESSIONS.am.start;
  const rows: CapacityRow[] = [];
  const staff = Object.values(state.staff).filter((s) => operates(s));
  let surgeonLists = 0;
  for (const sp of content.specialties) {
    const op = sp.surgery;
    const clinic = sp.outpatients;
    if (!op || !clinic) continue;
    const have = staff
      .filter((s) => s.specialty === sp.id)
      .reduce((n, s) => n + s.theatreSessions + s.privateTheatreSessions, 0);
    surgeonLists += have;
    const listed = Object.values(state.referrals).some(
      (r) => r.kind === "surgery" && r.specialty === sp.id,
    );
    const clinics = offersClinic(state, sp.id) || offersPrivateClinic(state, sp.id);
    if (!clinics && have === 0 && !listed) continue;
    const ops = clinicDemandPerDay(state, sp.id) * 7 * clinic.surgeryChance;
    const mins = ops * ((op.opMins[0] + op.opMins[1]) / 2 + TURNAROUND_MINS);
    rows.push({
      label: `${sp.name} theatre lists a week`,
      have,
      recommended: Math.ceil(mins / listMins),
      note: `About ${Math.round(ops)} operations a week from its clinics, ${Math.round(op.dayCaseShare * 100)}% day cases. Fewer lists and the surgical waiting list grows.`,
    });
  }
  if (surgeonLists === 0) return rows;
  const anaesthetic = staff
    .filter((s) => s.specialty === "anaesthetics")
    .reduce((n, s) => n + s.theatreSessions, 0);
  rows.push({
    label: "Anaesthetist lists a week",
    have: anaesthetic,
    recommended: surgeonLists,
    note: "One for every surgeon's list. A list without an anaesthetist doesn't run.",
  });
  rows.push(
    rotaRow(state, {
      label: "Theatre practitioners",
      have: Object.values(state.staff).filter((s) => s.role === "theatre_practitioner").length,
      recommended:
        PRACTITIONERS *
        Math.max(1, state.rooms.filter((r) => r.valid && r.typeId === "theatre").length),
      note: `${PRACTITIONERS} for each theatre that may be in use at once.`,
    }),
  );
  return rows;
}

function isBed(state: SimState, id: number): boolean {
  const defId = state.objects[id]?.defId;
  return defId === "hospital_bed" || defId === "profiling_bed";
}
