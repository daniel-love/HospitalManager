/**
 * Patient conditions (GAME_DESIGN §5.2). M2 added five walk-in "minors"
 * conditions and M3 the "majors" ones, which need a trolley in a Majors
 * Bay, close monitoring, and can deteriorate, and "resus" ones that need a
 * Resus Bay. Most majors and all resus patients come by ambulance. Ward
 * admissions come later in M3, and X-ray, CT and blood tests with
 * diagnostics in M4.
 *
 * Every A&E walk-in books in at reception and is triaged by a nurse first;
 * `pathway` lists what happens after triage. A patient who needs admitting
 * is then referred to the condition's `specialty`, whose team reviews them
 * in A&E and decides to admit (systems/admissions.ts). Tariffs are rough NHS prices
 * for a Type 1 A&E attendance at that level of investigation and treatment.
 */
import type { ConditionInput } from "./schema";

const MINORS = "minors_cubicle";
const MAJORS = "majors_bay";
const RESUS = "resus_bay";

// Minor injuries can be seen and treated start to finish by an Emergency
// Nurse Practitioner instead of a doctor (the NHS "see and treat" model).
// Roles are listed in order of preference: injuries go to a nurse
// practitioner first, keeping doctors free for illnesses, while nursing steps
// go to staff nurses first, keeping nurse practitioners free to assess.
// Illnesses stay doctor-led.
const INJURY_ASSESSOR = ["nurse_practitioner", "junior_doctor"] as const;
const INJURY_NURSING = ["nurse", "nurse_practitioner"] as const;
const DOCTOR = ["junior_doctor"] as const;
const NURSE = ["nurse"] as const;

export const conditions: ConditionInput[] = [
  {
    id: "laceration",
    name: "Laceration",
    acuity: 4,
    channels: { walk_in: 25 },
    tariff: 180,
    pathway: [
      { name: "Injury assessment", roles: [...INJURY_ASSESSOR], room: MINORS, mins: [15, 25] },
      { name: "Wound closure", roles: [...INJURY_NURSING], room: MINORS, mins: [15, 30] },
    ],
    description: "A cut that needs cleaning and closing with glue, strips or stitches.",
  },
  {
    id: "sprained_ankle",
    name: "Sprained ankle",
    acuity: 4,
    channels: { walk_in: 25 },
    tariff: 150,
    pathway: [
      { name: "Injury assessment", roles: [...INJURY_ASSESSOR], room: MINORS, mins: [15, 25] },
      { name: "Strapping and advice", roles: [...INJURY_NURSING], room: MINORS, mins: [10, 15] },
    ],
    description: "Soft-tissue injury. (X-rays to rule out a fracture arrive with imaging in M4.)",
  },
  {
    id: "minor_head_injury",
    name: "Minor head injury",
    acuity: 3,
    channels: { walk_in: 12, ambulance: 2 },
    specialty: "general_surgery",
    tariff: 220,
    admission: { chance: 0.05, stayHours: [12, 24], tariff: 1100 },
    pathway: [
      { name: "Injury assessment", roles: [...INJURY_ASSESSOR], room: MINORS, mins: [20, 30] },
      {
        name: "Neurological observations",
        roles: [...INJURY_NURSING],
        room: MINORS,
        mins: [15, 25],
      },
    ],
    description: "A knock to the head with no red flags. Assessed against NICE head injury rules.",
  },
  {
    id: "abdominal_pain",
    name: "Abdominal pain",
    acuity: 3,
    channels: { walk_in: 13 },
    specialty: "general_surgery",
    tariff: 260,
    admission: { chance: 0.15, stayHours: [24, 72], tariff: 1900 },
    pathway: [
      { name: "Doctor assessment", roles: [...DOCTOR], room: MINORS, mins: [25, 40] },
      { name: "Observations and pain relief", roles: [...NURSE], room: MINORS, mins: [10, 20] },
      { name: "Doctor review", roles: [...DOCTOR], room: MINORS, mins: [10, 15] },
    ],
    description: "Non-surgical tummy pain, managed with pain relief and a review.",
  },
  {
    id: "minor_illness",
    name: "Minor illness",
    acuity: 5,
    channels: { walk_in: 25 },
    tariff: 110,
    pathway: [{ name: "Doctor assessment", roles: [...DOCTOR], room: MINORS, mins: [10, 20] }],
    description: "Sore throat, earache or a urine infection: often something a GP could have seen.",
  },

  // Majors. Ambulances only bring these to a hospital with a working Majors
  // Bay; some walk in anyway, and are transferred out (systems/transfers.ts).
  {
    id: "chest_pain",
    name: "Chest pain",
    acuity: 2,
    channels: { walk_in: 6, ambulance: 8 },
    specialty: "cardiology",
    tariff: 420,
    monitoring: "continuous",
    deterioration: { chance: 0.15, onsetMins: [30, 150], warningMins: [45, 90] },
    admission: { chance: 0.4, stayHours: [18, 60], tariff: 2300 },
    pathway: [
      {
        name: "12-lead ECG",
        roles: [...NURSE],
        room: MAJORS,
        capabilities: ["ecg_12lead"],
        mins: [10, 15],
      },
      {
        name: "Doctor assessment and treatment",
        roles: [...DOCTOR],
        room: MAJORS,
        mins: [25, 40],
        stabilises: true,
      },
      { name: "Monitoring and repeat ECG", roles: [...NURSE], room: MAJORS, mins: [20, 30] },
      { name: "Doctor review", roles: [...DOCTOR], room: MAJORS, mins: [10, 15] },
    ],
    description:
      "Possible heart attack. Needs a 12-lead ECG within 10 minutes of arrival and continuous monitoring.",
  },
  {
    id: "shortness_of_breath",
    name: "Shortness of breath",
    acuity: 2,
    channels: { walk_in: 5, ambulance: 7 },
    specialty: "general_medicine",
    tariff: 380,
    monitoring: "continuous",
    deterioration: { chance: 0.2, onsetMins: [30, 120], warningMins: [40, 80] },
    admission: { chance: 0.5, stayHours: [48, 120], tariff: 2700, endOfLife: 0.03 },
    pathway: [
      {
        name: "Oxygen and nebulisers",
        roles: [...NURSE],
        room: MAJORS,
        capabilities: ["oxygen"],
        mins: [15, 25],
      },
      {
        name: "Doctor assessment and treatment",
        roles: [...DOCTOR],
        room: MAJORS,
        mins: [25, 35],
        stabilises: true,
      },
      { name: "Doctor review", roles: [...DOCTOR], room: MAJORS, mins: [10, 15] },
    ],
    description: "A flare-up of asthma or COPD. Can tire and worsen quickly.",
  },
  {
    id: "sepsis",
    name: "Suspected sepsis",
    acuity: 2,
    channels: { walk_in: 3, ambulance: 5 },
    specialty: "general_medicine",
    tariff: 520,
    monitoring: "continuous",
    deterioration: { chance: 0.4, onsetMins: [20, 90], warningMins: [40, 90] },
    admission: { chance: 0.85, stayHours: [72, 168], tariff: 3900, endOfLife: 0.06 },
    pathway: [
      { name: "Doctor assessment", roles: [...DOCTOR], room: MAJORS, mins: [20, 30] },
      {
        name: "Sepsis Six: antibiotics and fluids",
        roles: [...NURSE],
        room: MAJORS,
        mins: [20, 30],
        stabilises: true,
      },
      { name: "Doctor review", roles: [...DOCTOR], room: MAJORS, mins: [10, 15] },
    ],
    description:
      "Infection with signs of organ stress. Antibiotics are due within an hour; delay is dangerous.",
  },
  {
    id: "elderly_fall",
    name: "Fall in an older person",
    acuity: 3,
    channels: { walk_in: 2, ambulance: 9 },
    specialty: "general_medicine",
    tariff: 340,
    monitoring: "periodic",
    deterioration: { chance: 0.05, onsetMins: [60, 240], warningMins: [60, 120] },
    admission: { chance: 0.45, stayHours: [72, 192], tariff: 3400, endOfLife: 0.05 },
    pathway: [
      {
        name: "Doctor assessment",
        roles: [...DOCTOR],
        room: MAJORS,
        mins: [25, 40],
        stabilises: true,
      },
      { name: "Pressure care and mobility check", roles: [...NURSE], room: MAJORS, mins: [15, 25] },
      { name: "Doctor review", roles: [...DOCTOR], room: MAJORS, mins: [10, 15] },
    ],
    description:
      "Found on the floor or unsteady on their feet. Usually bruised; sometimes it hides something else.",
  },
  // Resus: by ambulance only.
  {
    id: "anaphylaxis",
    name: "Anaphylaxis",
    acuity: 1,
    channels: { walk_in: 0, ambulance: 2 },
    specialty: "general_medicine",
    tariff: 640,
    monitoring: "continuous",
    deterioration: { chance: 0.5, onsetMins: [5, 20], warningMins: [20, 40] },
    admission: { chance: 0.05, stayHours: [12, 24], tariff: 1200 },
    pathway: [
      {
        name: "Adrenaline, airway and fluids",
        roles: [...DOCTOR],
        room: RESUS,
        capabilities: ["resuscitation"],
        mins: [20, 30],
        stabilises: true,
      },
      // NICE: watch for a second reaction before going home. They move to
      // Majors once a bay is free, freeing Resus.
      { name: "Observation after anaphylaxis", roles: [...NURSE], room: MAJORS, mins: [120, 240] },
      { name: "Doctor review", roles: [...DOCTOR], room: MAJORS, mins: [10, 15] },
    ],
    description:
      "A severe allergic reaction: swelling, wheeze, low blood pressure. Needs adrenaline at once, then hours of observation.",
  },
  {
    id: "septic_shock",
    name: "Septic shock",
    acuity: 1,
    channels: { walk_in: 0, ambulance: 2 },
    specialty: "anaesthetics",
    tariff: 1450,
    monitoring: "continuous",
    deterioration: { chance: 0.6, onsetMins: [10, 30], warningMins: [30, 60] },
    outcome: "icu",
    pathway: [
      {
        name: "Resuscitation: fluids, antibiotics, oxygen",
        roles: [...DOCTOR],
        room: RESUS,
        capabilities: ["resuscitation"],
        mins: [30, 45],
        stabilises: true,
      },
      {
        name: "Critical care referral",
        roles: [...DOCTOR],
        specialty: "anaesthetics",
        room: RESUS,
        mins: [15, 25],
      },
    ],
    description:
      "Sepsis with dangerously low blood pressure. Stabilised in Resus, then transferred to intensive care.",
  },
];
