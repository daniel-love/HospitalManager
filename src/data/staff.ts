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
import type { StaffGroup, StaffRoleDef } from "./schema";

export const staffRoles: StaffRoleDef[] = [
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
    id: "medical_examiner",
    name: "Medical Examiner",
    short: "Medical Examiners",
    group: "medical",
    annualCost: 42_000,
    description:
      "A senior doctor dedicated to reviewing deaths, independently of the team that cared for the patient. Reviews every death at a desk before the death certificate is issued and the body can be released, and does no other work. Without one, the mortuary fills up.",
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
