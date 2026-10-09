/**
 * Patient conditions (GAME_DESIGN §5.2). M2 added five walk-in "minors"
 * conditions and M3 the "majors" ones, which need a trolley in a Majors
 * Bay, close monitoring, and can deteriorate, and "resus" ones that need a
 * Resus Bay. Most majors and all resus patients come by ambulance. Ward
 * admissions came later in M3, and X-rays, CT scans and blood tests in M4
 * (systems/diagnostics.ts): a step can take a blood sample, be a scan, or
 * wait for results, and some steps only some patients need (`chance`).
 *
 * Every A&E walk-in books in at reception and is triaged by a nurse first;
 * `pathway` lists what happens after triage. A patient who needs admitting
 * is then referred to the condition's `specialty`, whose team reviews them
 * in A&E and decides to admit (systems/admissions.ts). Tariffs are rough NHS prices
 * for a Type 1 A&E attendance at that level of investigation and treatment.
 */
import { CT_MINS, XRAY_MINS } from "./diagnostics";
import type { ConditionInput } from "./schema";

const MINORS = "minors_cubicle";
const MAJORS = "majors_bay";
const RESUS = "resus_bay";

/** An X-ray or CT scan by a radiographer, for `chance` of patients. */
function scan(imaging: "xray" | "ct", name: string, chance = 1): ConditionInput["pathway"][number] {
  return {
    name,
    roles: ["radiographer"],
    room: imaging === "xray" ? "xray_room" : "ct_room",
    capabilities: [imaging],
    imaging,
    mins: imaging === "xray" ? [...XRAY_MINS] : [...CT_MINS],
    chance,
  };
}

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
    channels: { walk_in: 20 },
    tariff: 150,
    pathway: [
      { name: "Injury assessment", roles: [...INJURY_ASSESSOR], room: MINORS, mins: [15, 25] },
      // Ottawa ankle rules: about a third need an X-ray to rule out a fracture.
      scan("xray", "Ankle X-ray", 0.35),
      {
        name: "Strapping and advice",
        roles: [...INJURY_NURSING],
        room: MINORS,
        mins: [10, 15],
        needsResults: true,
      },
    ],
    description:
      "Soft-tissue injury. About a third meet the Ottawa ankle rules for an X-ray, which shows no fracture.",
  },
  {
    id: "broken_ankle",
    name: "Broken ankle",
    acuity: 3,
    channels: { walk_in: 6, ambulance: 1 },
    specialty: "trauma_orthopaedics",
    tariff: 290,
    // Unstable fractures need surgery (ORIF); the rest go home in a backslab
    // with a fracture clinic appointment.
    admission: { chance: 0.15, stayHours: [24, 72], tariff: 3600 },
    pathway: [
      { name: "Injury assessment", roles: [...INJURY_ASSESSOR], room: MINORS, mins: [15, 25] },
      scan("xray", "Ankle X-ray"),
      {
        name: "Backslab plaster and fracture clinic referral",
        roles: [...INJURY_NURSING],
        room: MINORS,
        mins: [25, 40],
        needsResults: true,
      },
    ],
    description:
      "A fracture, found on X-ray. A plaster backslab and a fracture clinic appointment; unstable ones are admitted under orthopaedics for surgery.",
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
      // NICE: a CT head within an hour for those with risk factors.
      scan("ct", "CT head", 0.25),
      {
        name: "Neurological observations",
        roles: [...INJURY_NURSING],
        room: MINORS,
        mins: [15, 25],
        needsResults: true,
      },
    ],
    description:
      "A knock to the head. Assessed against NICE head injury rules: about a quarter need a CT head within an hour.",
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
      {
        name: "Bloods, observations and pain relief",
        roles: [...NURSE],
        room: MINORS,
        mins: [15, 25],
        sample: true,
      },
      {
        name: "Doctor review with results",
        roles: [...DOCTOR],
        room: MINORS,
        mins: [10, 15],
        needsResults: true,
      },
    ],
    description: "Tummy pain: pain relief, blood tests and a review once the results are back.",
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
      {
        name: "Bloods (troponin), monitoring and repeat ECG",
        roles: [...NURSE],
        room: MAJORS,
        mins: [20, 30],
        sample: true,
      },
      {
        name: "Doctor review with troponin result",
        roles: [...DOCTOR],
        room: MAJORS,
        mins: [10, 15],
        needsResults: true,
      },
    ],
    description:
      "Possible heart attack. Needs a 12-lead ECG within 10 minutes of arrival, continuous monitoring, and a troponin blood test before anyone can rule it in or out.",
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
        sample: true,
      },
      scan("xray", "Chest X-ray", 0.8),
      {
        name: "Doctor review with results",
        roles: [...DOCTOR],
        room: MAJORS,
        mins: [10, 15],
        needsResults: true,
      },
    ],
    description:
      "A flare-up of asthma or COPD. Can tire and worsen quickly. Most need a chest X-ray and blood tests.",
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
        name: "Sepsis Six: cultures, lactate, antibiotics and fluids",
        roles: [...NURSE],
        room: MAJORS,
        mins: [20, 30],
        stabilises: true,
        sample: true,
      },
      {
        name: "Doctor review with results",
        roles: [...DOCTOR],
        room: MAJORS,
        mins: [10, 15],
        needsResults: true,
      },
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
      // NICE: a CT head for anyone on blood thinners who hits their head.
      scan("ct", "CT head", 0.3),
      {
        name: "Bloods, pressure care and mobility check",
        roles: [...NURSE],
        room: MAJORS,
        mins: [15, 25],
        sample: true,
      },
      {
        name: "Doctor review with results",
        roles: [...DOCTOR],
        room: MAJORS,
        mins: [10, 15],
        needsResults: true,
      },
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
