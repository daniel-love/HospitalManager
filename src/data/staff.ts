/**
 * Staff roles that can be hired. Each belongs to a group (medical, nursing,
 * support services, administrative), which decides where it's listed in the
 * Hire panel and People dialog; within a group, roles keep this order. Costs are rough 2025/26 NHS pay (Agenda for
 * Change bands, resident doctor scale) plus about 28% employer on-costs
 * (National Insurance and pension).
 *
 * Until shifts and rotas arrive (M5), each person hired works around the
 * clock, so staffing is cheaper than it really would be.
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

export const staffRoles: StaffRoleInput[] = [
  {
    id: "consultant",
    name: "Consultant",
    short: "Consultants",
    group: "medical",
    annualCost: 160_000,
    specialist: true,
    description:
      "The senior doctor of a specialty. Reviews A&E patients referred to the specialty and decides to admit them, like a registrar. Can be resident (always in the hospital) or on call from home: much cheaper, but called in only when nobody from the specialty is in the hospital, and takes 20 to 40 minutes to arrive. A resident consultant can be given the Medical Examiner duty (in their inspector): they review deaths at a desk, Monday to Friday 09:00 to 17:00, but never a death of a patient they treated.",
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
    id: "porter",
    name: "Porter",
    short: "Porters",
    group: "support",
    annualCost: 31_500,
    description:
      "Band 2. Wheels admitted patients on their bed from A&E to a ward. Beds need double doors and corridors at least 2 tiles wide. Without porters, admitted patients stay on A&E trolleys.",
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
  nursing: "Nursing",
  support: "Support services",
  admin: "Administrative",
};
