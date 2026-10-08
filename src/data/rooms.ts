/**
 * Room types the player can zone. A room is valid (and, from M2, functional)
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
    description: "For seriously unwell patients who need a trolley and monitoring.",
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
];
