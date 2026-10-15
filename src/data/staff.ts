/**
 * Staff roles that can be hired. Each belongs to a group (medical, nursing,
 * support services, administrative), which decides where it's listed in the
 * Staff screen; within a group, roles keep this order. Costs are rough 2025/26 UK hospital pay (national
 * pay bands, resident doctor scale) plus about 28% employer on-costs
 * (National Insurance and pension).
 *
 * Each person works a full-time contract of 37.5 hours a week (see SHIFTS),
 * so keeping a post filled around the clock takes about five people.
 */
import type { StaffGroup, StaffRoleInput } from "./schema";

/**
 * Consultants can be on call instead of resident (GAME_DESIGN §6.1): at home
 * until a patient needs their specialty and nobody from it is in the
 * hospital, then called in. The hospital pays an availability supplement
 * (about 5% of salary, with on-costs) plus their time on site, and they go
 * home once there's been nothing for them to do for a while.
 */
export const ON_CALL = {
  /** £ a year for being available. */
  retainer: 8_000,
  /** £ an hour while in the hospital (a consultant's pay with on-costs). */
  hourly: 80,
  /** Minutes from the call to arriving at the hospital. */
  calloutMins: [20, 40] as const,
  /** Minutes with nothing to do before they go home. */
  homeAfterIdleMins: 60,
};

/**
 * Shifts (GAME_DESIGN §6.3): UK hospital long days and nights of 12.5 hours, with
 * half an hour's handover where they overlap. A full-time contract is three
 * a week. Consultants, and registrars with clinics or theatre lists in their
 * job plan, work weekdays instead, and consultants take turns on call from
 * home out of hours. Times are minutes after midnight.
 */
export const SHIFTS = {
  dayStart: 7 * 60 + 30,
  nightStart: 19 * 60 + 30,
  lengthMins: 12 * 60 + 30,
  perWeek: 3,
  /** Shifts a week someone can be rostered for at most (the Working Time Directive's 48 hours). */
  maxPerWeek: 4,
  /** Doctors working weekdays: Monday to Friday, these hours. */
  weekdayStart: 8 * 60,
  weekdayEnd: 18 * 60,
  /** With no cover levels set, the share of each group's shifts that are days. */
  defaultDayShare: 0.6,
};

/**
 * Unsocial hours pay (bands 3 and up): extra on top of
 * basic pay for hours worked between 20:00 and 06:00 or on a Saturday, and
 * more on a Sunday. Resident doctors' night enhancement is similar.
 */
export const UNSOCIAL = {
  night: 0.3,
  saturday: 0.3,
  sunday: 0.6,
  nightFrom: 20,
  nightTo: 6,
  /** Paid hours in a year at 37.5 a week: an hour's basic pay is the salary divided by this. */
  hoursPerYear: 37.5 * 52.14,
};

/**
 * Nurse bands (national pay bands, GAME_DESIGN §6.1). Band 5 staff nurses do
 * most of the nursing; Band 6 senior staff nurses are more experienced; a
 * Band 7 sister or charge nurse on a shift is its nurse in charge, who
 * keeps the department moving (NURSE_IN_CHARGE). Pay with on-costs, like
 * the roles' (2025/26 points: £31.0k, £38.7k, £47.8k).
 */
export const NURSE_BANDS = [
  { band: 5, title: "Staff Nurse", annualCost: 40_500, skill: [35, 65] },
  { band: 6, title: "Senior Staff Nurse", annualCost: 49_500, skill: [55, 80] },
  { band: 7, title: "Charge Nurse", annualCost: 61_000, skill: [70, 90] },
] as const;
export type NurseBand = (typeof NURSE_BANDS)[number]["band"];

/**
 * While a Band 7 nurse is on duty, the nursing team works this much faster:
 * they allocate patients, chase delays and keep the board moving. One is
 * enough; a second doesn't add more.
 */
export const NURSE_IN_CHARGE = { speedUp: 0.1 };

/**
 * Skill (0–100) sets how quickly someone works: from SKILL.slowest at 0 to
 * SKILL.fastest at 100. New starters get a random skill in their range, and
 * it grows with hours worked, up to SKILL.max.
 */
export const SKILL = {
  range: [40, 80] as const,
  slowest: 0.85,
  fastest: 1.15,
  growthPerHour: 0.02,
  max: 95,
};

/**
 * Fatigue (0–100) builds on shift, faster while busy, and falls while off
 * duty. Above `slowFrom` people work more slowly (down to `slowest` at
 * 100) and their morale suffers.
 */
export const FATIGUE = {
  perHourOnShift: 3,
  perHourBusy: 2,
  recoveryPerHour: 6,
  slowFrom: 50,
  slowest: 0.8,
  /** Morale lost per hour while fatigue is above this. */
  moraleFrom: 75,
  moralePerHour: 0.5,
};

/**
 * Morale (0–100). It drifts back towards a baseline, and each shift's
 * workload moves it: a shift where someone was busy most of the time, or
 * their group was short, wears it down. Low morale brings sickness and
 * resignations.
 */
export const MORALE = {
  start: 75,
  recoveryPerHour: 0.5,
  /** At the end of a shift busy for more than this share of it… */
  busyShare: 0.8,
  busyHit: 3,
  /** …or one where their group started short of its cover. */
  shortHit: 2,
  /** A shift busy less than this share of it lifts morale a little. */
  quietShare: 0.4,
  quietLift: 1,
  /** Below this, people work a little more slowly. */
  lowFrom: 40,
  lowSlowest: 0.95,
};

/**
 * Sickness absence: the chance someone rostered calls in sick for a shift
 * (the UK hospital rate is about 5%), rising as morale falls below `fromMorale`
 * and when they're tired.
 */
export const SICKNESS = {
  base: 0.045,
  fromMorale: 50,
  /** Multiplies the chance at morale 0 (scaled linearly from fromMorale). */
  lowMoraleFactor: 3,
  tiredFrom: 60,
  tiredFactor: 1.5,
};

/**
 * Resignations: checked once a day. Below `fromMorale` someone may hand in
 * their notice (`dailyChance` at 0 morale, scaled linearly), then works it
 * out before leaving.
 */
export const RESIGNATION = {
  fromMorale: 30,
  dailyChance: 0.12,
  noticeDays: 28,
};

/**
 * Filling rota gaps (GAME_DESIGN §6.2): at the start of each shift, a gap
 * against the cover can go to the staff bank (the hospital's own pool,
 * paid by the hour at the normal rate; not always filled) and then to an
 * agency (always found, at about twice the cost, and less familiar with
 * the hospital, so a little slower).
 */
export const BANK = { fillChance: 0.65, payFactor: 1 };
export const AGENCY = { payFactor: 2, skill: [30, 60] as const, unfamiliar: 0.9 };

export const staffRoles: StaffRoleInput[] = [
  {
    id: "consultant",
    name: "Consultant",
    short: "Consultants",
    group: "medical",
    annualCost: 160_000,
    specialist: true,
    description:
      "The senior doctor of a specialty. Reviews A&E patients referred to the specialty and decides to admit them, like a registrar. Can be resident, working weekdays 08:00 to 18:00 and taking turns with the specialty's other resident consultants to be on call from home out of hours, or purely on call from home: much cheaper, but called in only when nobody from the specialty is in the hospital, and takes 20 to 40 minutes to arrive. A resident consultant can be given the Medical Examiner duty (in their inspector): they review deaths at a desk, Monday to Friday 09:00 to 17:00, but never a death of a patient they treated.",
  },
  {
    id: "registrar",
    name: "Registrar",
    short: "Registrars",
    group: "medical",
    annualCost: 88_000,
    specialist: true,
    description:
      "A specialty trainee (ST3+), resident in the hospital. Takes referrals from A&E for their specialty: reviews the patient on their trolley and decides to admit them. Without a team for a specialty, its patients can't be admitted here and are transferred to another hospital.",
  },
  {
    id: "junior_doctor",
    name: "Junior Doctor",
    short: "Doctors",
    group: "medical",
    annualCost: 65_000,
    description:
      "FY2/SHO resident doctor. Assesses and treats patients in Minors and Majors, leads resuscitation at a cardiac arrest, and decides when patients can go home.",
  },
  {
    id: "nurse",
    name: "Nurse",
    short: "Nurses",
    group: "nursing",
    annualCost: 40_500,
    description:
      "Triages every patient (Manchester Triage), does nursing steps such as wound closure and ECGs, and takes observations. Between jobs, waits at a nurse station and watches the beds in sight. Hired at Band 5 (staff nurse), 6 (senior staff nurse) or 7 (charge nurse, the nurse in charge of a shift).",
  },
  {
    id: "nurse_practitioner",
    name: "Emergency Nurse Practitioner",
    short: "Nurse practitioners",
    group: "nursing",
    annualCost: 63_000,
    description:
      "Band 7 advanced nurse. Sees and treats minor injuries (cuts, sprains, minor head injuries) from start to finish without a doctor, and can do any nursing step for those patients. Doesn't triage, and illnesses such as abdominal pain still need a doctor.",
  },
  {
    id: "radiographer",
    name: "Radiographer",
    short: "Radiographers",
    group: "diagnostics",
    annualCost: 49_500,
    description:
      "Band 6. Takes X-rays and does CT scans in the X-ray and CT Rooms. Patients come to them: walking from Minors, or from their Majors trolley, which is kept for them. With a portable X-ray, they X-ray patients who shouldn't leave their monitoring on their trolley.",
  },
  {
    id: "biomedical_scientist",
    name: "Biomedical Scientist",
    short: "Lab scientists",
    group: "diagnostics",
    annualCost: 40_500,
    description:
      "Band 5, HCPC registered. Processes blood samples in the Pathology Lab once a porter brings them; results follow when the analyser has run. Without one, no blood results.",
  },
  {
    id: "theatre_practitioner",
    name: "Theatre Practitioner",
    short: "Theatre practitioners",
    group: "nursing",
    annualCost: 45_000,
    description:
      "Band 5/6 scrub nurse or operating department practitioner (ODP). Every operation needs two: one scrubbed to pass instruments to the surgeon, one assisting the anaesthetist. They also wheel patients from theatre to Recovery. Without two free, a theatre list can't start.",
  },
  {
    id: "discharge_coordinator",
    name: "Discharge Coordinator",
    short: "Discharge coordinators",
    group: "nursing",
    annualCost: 49_500,
    description:
      "Band 6, working weekdays 08:00 to 18:00. Sees each newly admitted patient who'll need social care to go home (a package of care, a care home place) and asks for it straight away, so the wait runs alongside their treatment. Without one, a ward nurse asks only once the patient is fit to go, and the whole wait comes after, holding a ward bed.",
  },
  {
    id: "clinical_engineer",
    name: "Clinical Engineer",
    short: "Clinical engineers",
    group: "support",
    annualCost: 45_000,
    description:
      "Band 5/6 EBME technician (electronic and biomedical engineering). Repairs equipment that breaks down, from monitors to the CT scanner, and does planned preventive maintenance on worn kit between repairs, keeping breakdowns down. Without one, broken equipment stays out of service.",
  },
  {
    id: "porter",
    name: "Porter",
    short: "Porters",
    group: "support",
    annualCost: 31_500,
    description:
      "Band 2. Wheels admitted patients on their bed from A&E to a ward, wheels Majors and Resus patients to X-ray and CT and back, and takes blood samples to the Pathology Lab. Beds need double doors and corridors at least 2 tiles wide. Without porters, admitted patients stay on A&E trolleys and samples never reach the lab.",
  },
  {
    id: "cleaner",
    name: "Cleaner",
    short: "Cleaners",
    group: "support",
    annualCost: 31_500,
    description:
      "Band 2 domestic. Cleans cubicles, trolleys and ward beds between patients and keeps toilets usable. A dirty bed can't be used.",
  },
  {
    id: "receptionist",
    name: "Receptionist",
    short: "Reception",
    group: "admin",
    annualCost: 31_500,
    description:
      "Band 2. Sits behind an A&E reception desk and books patients in. Without one, the queue at the desk never moves.",
  },
];

/** Headings for each staff group, as the Staff screen shows them. */
export const STAFF_GROUP_NAMES: Record<StaffGroup, string> = {
  medical: "Medical",
  nursing: "Nursing & theatres",
  diagnostics: "Diagnostics",
  support: "Support services",
  admin: "Administrative",
};
