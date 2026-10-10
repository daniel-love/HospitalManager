/**
 * Staff roles that can be hired. Each belongs to a group (medical, nursing,
 * support services, administrative), which decides where it's listed in the
 * Hire panel and People dialog; within a group, roles keep this order. Costs are rough 2025/26 NHS pay (Agenda for
 * Change bands, resident doctor scale) plus about 28% employer on-costs
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
 * Shifts (GAME_DESIGN §6.3): NHS long days and nights of 12.5 hours, with
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
 * Unsocial hours pay (Agenda for Change, bands 3 and up): extra on top of
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
    name: "Staff Nurse",
    short: "Nurses",
    group: "nursing",
    annualCost: 40_500,
    description:
      "Band 5. Triages every patient (Manchester Triage), does nursing steps such as wound closure and ECGs, and takes observations. Between jobs, waits at a nurse station and watches the beds in sight.",
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

/** Headings for each staff group, as the Hire panel shows them. */
export const STAFF_GROUP_NAMES: Record<StaffGroup, string> = {
  medical: "Medical",
  nursing: "Nursing & theatres",
  diagnostics: "Diagnostics",
  support: "Support services",
  admin: "Administrative",
};
