/**
 * Room types the player can zone. A room is valid (and functional)
 * only when every requirement is met. See GAME_DESIGN §4.2.
 */

const bedOrCouch = ["exam_couch", "trolley"];
const anyMonitor = ["obs_machine", "bedside_monitor"];
const patientBed = ["trolley", "hospital_bed", "profiling_bed"];

export const rooms = [
  {
    id: "corridor",
    code: 1,
    name: "Corridor",
    department: "General",
    colour: 0x9aa3ad,
    minSize: [1, 1],
    enclosed: false,
    required: [],
    description: "Circulation space. 2+ tiles wide is needed for beds and trolleys.",
  },
  {
    id: "ae_reception",
    code: 2,
    name: "A&E Reception",
    department: "A&E",
    colour: 0x4f9de0,
    minSize: [3, 3],
    enclosed: false,
    required: [{ label: "Reception desk", anyOf: ["reception_desk"] }],
    connectedTo: [{ roomType: "waiting_area", label: "Opens onto a Waiting Area" }],
    // No seating: patients queue at the desk (its front must stay clear), then
    // sit in a Waiting Area.
    description:
      "Patients queue at the desk to book in, then go to a Waiting Area. Place it near the entrance, opening onto the waiting area.",
  },
  {
    id: "waiting_area",
    code: 3,
    name: "Waiting Area",
    // Shared: outpatient clinics (M4) will use waiting areas too.
    department: "Any",
    colour: 0x6cc0b0,
    minSize: [3, 3],
    enclosed: false,
    required: [],
    minSeats: 6,
    description: "Patients and companions wait here. Toilets nearby are recommended.",
  },
  {
    id: "triage_room",
    code: 4,
    name: "Triage Room",
    department: "A&E",
    colour: 0xe0a84f,
    minSize: [3, 3],
    enclosed: true,
    required: [
      { label: "Examination couch or trolley", anyOf: bedOrCouch },
      { label: "Observations machine", anyOf: anyMonitor },
      { label: "Hand-wash sink", anyOf: ["sink"] },
    ],
    description: "A nurse assesses each patient's urgency (Manchester Triage).",
  },
  {
    id: "minors_cubicle",
    code: 5,
    name: "Minors Cubicle",
    department: "A&E",
    colour: 0x8fd16a,
    minSize: [2, 3],
    enclosed: false,
    required: [
      { label: "Examination couch or trolley", anyOf: bedOrCouch },
      { label: "Privacy curtain", anyOf: ["privacy_curtain"] },
      { label: "Observations machine", anyOf: anyMonitor },
    ],
    description: "Treats minor injuries and illnesses. Separate cubicles with walls.",
  },
  {
    id: "majors_bay",
    code: 6,
    name: "Majors Bay",
    department: "A&E",
    colour: 0xe07a5f,
    minSize: [3, 3],
    enclosed: false,
    required: [
      { label: "Trolley or bed", anyOf: patientBed },
      { label: "Bedside monitor", anyOf: ["bedside_monitor"] },
      { label: "Piped oxygen point", anyOf: ["oxygen_point"] },
      { label: "Privacy curtain", anyOf: ["privacy_curtain"] },
    ],
    bothBedSides: true,
    observed: true,
    description:
      "For seriously unwell patients who need a trolley and monitoring. Every trolley should be in sight of a nurse station.",
  },
  {
    id: "resus_bay",
    code: 7,
    name: "Resus Bay",
    department: "A&E",
    colour: 0xd0454c,
    minSize: [5, 5],
    enclosed: false,
    required: [
      { label: "Patient trolley", anyOf: ["trolley"] },
      { label: "Bedside monitor", anyOf: ["bedside_monitor"] },
      { label: "Defibrillator", anyOf: ["defibrillator"] },
      { label: "Resus trolley", anyOf: ["resus_trolley"] },
      { label: "Ventilator", anyOf: ["ventilator"] },
      { label: "Piped oxygen point", anyOf: ["oxygen_point"] },
      { label: "Suction unit", anyOf: ["suction_unit"] },
    ],
    bothBedSides: true,
    observed: true,
    description: "Life-threatening emergencies. Best placed next to the ambulance entrance.",
  },
  {
    id: "toilets",
    code: 8,
    name: "Toilets",
    department: "Facilities",
    colour: 0xa98fd6,
    minSize: [2, 2],
    enclosed: true,
    required: [
      { label: "Toilet", anyOf: ["toilet"] },
      { label: "Hand-wash sink", anyOf: ["sink"] },
    ],
    description: "At least 2×2 so it is wheelchair accessible.",
  },
  {
    id: "staff_room",
    code: 9,
    name: "Staff Room",
    department: "Staff",
    colour: 0xd6c56b,
    minSize: [3, 3],
    enclosed: true,
    required: [{ label: "Kitchenette", anyOf: ["kitchenette"] }],
    minSeats: 4,
    description: "Staff rest here between jobs to recover from fatigue (M5).",
  },
  {
    id: "ambulance_bay",
    code: 10,
    name: "Ambulance Bay",
    department: "A&E",
    colour: 0xe8c547,
    minSize: [3, 6],
    enclosed: false,
    required: [],
    description:
      "Hardstanding outside A&E where an ambulance parks while its crew hands the patient over. Zone it on foundations; each clear 3×6 space holds one ambulance. Without one, no ambulances come.",
  },
  {
    id: "ward",
    code: 11,
    name: "Ward",
    department: "Inpatient",
    colour: 0x7fa6d9,
    minSize: [4, 4],
    enclosed: true,
    required: [
      { label: "Hospital bed", anyOf: ["hospital_bed", "profiling_bed"] },
      { label: "Hand-wash sink", anyOf: ["sink"] },
    ],
    description:
      "Admitted patients stay here for days. Each bed needs a bed-width route (double doors, 2-wide corridors) from A&E for the porters.",
  },
  {
    id: "side_room",
    code: 12,
    name: "Side Room",
    department: "Inpatient",
    colour: 0x9cb8e0,
    minSize: [3, 4],
    enclosed: true,
    required: [
      { label: "Hospital bed", anyOf: ["hospital_bed", "profiling_bed"] },
      { label: "Hand-wash sink", anyOf: ["sink"] },
    ],
    description:
      "A single room off a ward, for privacy. Patients at the end of their life are given one when it's free; dying in an open bay brings complaints.",
  },
  {
    id: "relatives_room",
    code: 13,
    name: "Relatives' Room",
    department: "Facilities",
    colour: 0xc9a3c9,
    minSize: [3, 3],
    enclosed: true,
    required: [{ label: "Sofa", anyOf: ["sofa"] }],
    description:
      "A quiet room where a doctor breaks bad news to a family. Without one, it happens in a corridor or cubicle, which brings complaints.",
  },
  {
    id: "mortuary",
    code: 14,
    name: "Mortuary",
    department: "Support",
    colour: 0x8a8f99,
    minSize: [3, 3],
    enclosed: true,
    required: [{ label: "Mortuary fridge unit", anyOf: ["mortuary_fridge"] }],
    description:
      "Where deceased patients stay until the Medical Examiner (and sometimes the coroner) is done and they're released. Needs a bed-width route from the wards and A&E; best kept away from public areas.",
  },
];
