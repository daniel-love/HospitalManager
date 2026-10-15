/**
 * Room types the player can zone. A room is valid (and functional)
 * only when every requirement is met. See GAME_DESIGN §4.2.
 */
import type { RoomDepartment, RoomInput } from "./schema";

const bedOrCouch = ["exam_couch", "trolley"];
const anyMonitor = ["obs_machine", "bedside_monitor"];
const patientBed = ["trolley", "hospital_bed", "profiling_bed"];

export const rooms: RoomInput[] = [
  {
    id: "corridor",
    code: 1,
    name: "Corridor",
    department: "General",
    colour: 0x9aa3ad,
    minSize: [1, 1],
    enclosed: false,
    publicRoute: true,
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
    publicRoute: true,
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
    publicRoute: true,
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
    description:
      "Treats minor injuries and illnesses. Separate cubicles with walls or curtain dividers.",
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
      { label: "Toilet or cubicle", anyOf: ["toilet", "toilet_cubicle"] },
      { label: "Hand-wash sink", anyOf: ["sink"] },
    ],
    description:
      "At least 2×2 so it is wheelchair accessible. For a bigger block, line up cubicles and urinals with a sink or two.",
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
    description:
      "Where staff take their breaks (from M5, when fatigue arrives). Until then, staff with no base of their own wait here between jobs.",
  },
  {
    id: "ambulance_bay",
    code: 10,
    name: "Ambulance Bay",
    department: "A&E",
    colour: 0xe8c547,
    minSize: [3, 6],
    enclosed: false,
    onRoad: true,
    required: [],
    description:
      "Hardstanding outside A&E where an ambulance parks while its crew hands the patient over. Zone it on access road (or foundations); each clear 3×6 space holds one ambulance. Without one, no ambulances come.",
  },
  {
    id: "ward",
    code: 11,
    name: "Ward",
    department: "Inpatient",
    colour: 0x7fa6d9,
    minSize: [4, 4],
    enclosed: true,
    specialty: true,
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
  {
    id: "xray_room",
    code: 15,
    name: "X-ray Room",
    department: "Diagnostics",
    colour: 0x7bb8c9,
    minSize: [4, 4],
    enclosed: true,
    shielded: true,
    required: [{ label: "X-ray unit", anyOf: ["xray_unit"] }],
    description:
      "Plain X-rays, for suspected fractures and chest X-rays. A radiographer takes them. Must be enclosed by lead-lined walls.",
  },
  {
    id: "ct_room",
    code: 16,
    name: "CT Room",
    department: "Diagnostics",
    colour: 0x5f9fb5,
    minSize: [5, 5],
    enclosed: true,
    shielded: true,
    required: [{ label: "CT scanner", anyOf: ["ct_scanner"] }],
    description:
      "CT scans, such as of the head after an injury (NICE: within an hour for those who need one). A radiographer does the scan; a radiologist reports it. Must be enclosed by lead-lined walls; best close to A&E.",
  },
  {
    id: "lab",
    code: 17,
    name: "Pathology Lab",
    department: "Diagnostics",
    colour: 0xb39ddb,
    minSize: [3, 3],
    enclosed: true,
    required: [{ label: "Blood analyser", anyOf: ["blood_analyser"] }],
    description:
      "Biomedical scientists process blood samples here; porters bring them from the wards and A&E. Without one, nobody's bloods can be tested.",
  },
  {
    id: "staff_base",
    code: 18,
    name: "A&E Staff Base",
    department: "A&E",
    colour: 0xc98f6b,
    minSize: [3, 3],
    enclosed: false,
    required: [{ label: "Desk", anyOf: ["desk"] }],
    description:
      "The hub of the department, where doctors and nurse practitioners write notes and wait for the next patient. Nurses wait here too when every nurse station is taken. Best central, close to Minors and Majors.",
  },
  {
    id: "porters_lodge",
    code: 19,
    name: "Porters' Lodge",
    department: "Support",
    colour: 0xa0a86b,
    minSize: [3, 3],
    enclosed: true,
    required: [{ label: "Desk", anyOf: ["desk"] }],
    description:
      "Porters wait here for their next job. Somewhere central keeps their walks to A&E, the wards and the lab short.",
  },
  {
    id: "domestic_services_room",
    code: 20,
    name: "Domestic Services Room",
    department: "Support",
    colour: 0x8fb0a0,
    minSize: [2, 2],
    enclosed: true,
    required: [{ label: "Hand-wash sink", anyOf: ["sink"] }],
    description:
      "The cleaners' base, where their trolleys and supplies are kept. Cleaners wait here between jobs.",
  },
  {
    id: "plant_room",
    code: 27,
    name: "Plant Room",
    department: "Support",
    colour: 0x8a8f96,
    minSize: [3, 3],
    enclosed: true,
    required: [],
    description:
      "Houses the standby generators that keep the essential supply on in a power cut, and the clinical engineers' workshop: they wait here between repairs.",
  },
  {
    id: "doctors_office",
    code: 28,
    name: "Doctors' Office",
    department: "Staff",
    colour: 0xb88f6b,
    minSize: [3, 3],
    enclosed: true,
    required: [{ label: "Desk", anyOf: ["desk"] }],
    description:
      "Where consultants and registrars write letters, discharge summaries and other admin between ward rounds, referrals, clinics and theatre. One desk per doctor; without a free desk they wait on their specialty's ward.",
  },
  {
    id: "outpatients_reception",
    code: 21,
    name: "Outpatients Reception",
    department: "Outpatients",
    colour: 0x5bb0c9,
    minSize: [3, 3],
    enclosed: false,
    publicRoute: true,
    required: [{ label: "Reception desk", anyOf: ["reception_desk"] }],
    connectedTo: [{ roomType: "waiting_area", label: "Opens onto a Waiting Area" }],
    description:
      "Outpatients book in here for their appointment, then wait in the Waiting Area it opens onto. Needs its own receptionist: one at A&E Reception stays there.",
  },
  {
    id: "outpatient_clinic",
    code: 22,
    name: "Outpatient Clinic Room",
    department: "Outpatients",
    colour: 0x8fcfb8,
    // A consulting and examination room is about 16 m² (NHS HBN 00-03).
    minSize: [3, 4],
    enclosed: true,
    specialty: true,
    required: [
      { label: "Desk", anyOf: ["desk"] },
      { label: "Examination couch", anyOf: ["exam_couch"] },
      { label: "Hand-wash sink", anyOf: ["sink"] },
    ],
    description:
      "A consultant or registrar sees booked outpatients here in clinic sessions (mornings 09:00 to 13:00, afternoons 13:30 to 17:30, Monday to Friday). Give it a specialty in the inspector, or leave it open to any.",
  },
  {
    id: "theatre",
    code: 23,
    name: "Operating Theatre",
    department: "Theatres",
    colour: 0x7cc3d6,
    // An NHS operating theatre is about 55 m² (HBN 26).
    minSize: [6, 6],
    enclosed: true,
    specialty: true,
    required: [
      { label: "Operating table", anyOf: ["operating_table"] },
      { label: "Anaesthetic machine", anyOf: ["anaesthetic_machine"] },
      { label: "Operating light", anyOf: ["operating_light"] },
      { label: "Scrub sink", anyOf: ["sink"] },
    ],
    description:
      "Where operations happen: planned theatre lists in the week, and emergencies at any time. Give it a specialty, leave it open to any, or keep it for emergencies so they don't cancel planned operations. Needs a bed-width route to Recovery, the wards and A&E.",
  },
  {
    id: "recovery",
    code: 24,
    name: "Recovery",
    department: "Theatres",
    colour: 0xa6d8e4,
    minSize: [3, 3],
    enclosed: false,
    required: [
      { label: "Trolley or bed", anyOf: patientBed },
      { label: "Bedside monitor", anyOf: ["bedside_monitor"] },
      { label: "Piped oxygen point", anyOf: ["oxygen_point"] },
    ],
    description:
      "Patients come round from the anaesthetic here, on a trolley with a nurse beside them, before going home or to a ward. Without a free Recovery trolley, the next operation can't finish. Put it next to the theatres.",
  },
  {
    id: "day_surgery_unit",
    code: 25,
    name: "Day Surgery Unit",
    department: "Theatres",
    colour: 0xc2e3c8,
    minSize: [4, 4],
    enclosed: true,
    minSeats: 4,
    required: [{ label: "Nurses' desk", anyOf: ["desk"] }],
    description:
      "Patients coming in for a planned operation are admitted here on the day by a nurse, and wait for theatre. Day cases come back here from Recovery to get ready to go home.",
  },
  {
    id: "discharge_lounge",
    code: 26,
    name: "Discharge Lounge",
    department: "Inpatient",
    colour: 0xb7cfe8,
    minSize: [3, 3],
    enclosed: false,
    minSeats: 4,
    required: [],
    description:
      "Ward patients going home wait here for their medicines and transport, from 08:00 to 20:00, freeing their ward bed hours earlier. Patients waiting for social care stay on the ward.",
  },
];

/** Build palette sections for rooms, in display order. */
export const roomGroups = [
  "ae",
  "wards",
  "outpatients",
  "theatres",
  "diagnostics",
  "shared",
  "facilities",
  "support",
  "staff",
] as const;
export type RoomGroup = (typeof roomGroups)[number];

export const ROOM_GROUP_NAMES: Record<RoomGroup, string> = {
  ae: "A&E",
  wards: "Wards",
  outpatients: "Outpatients",
  theatres: "Theatres",
  diagnostics: "Diagnostics",
  shared: "Shared spaces",
  facilities: "Facilities",
  support: "Support services",
  staff: "Staff areas",
};

/** The palette section each department's rooms go in. */
export const ROOM_GROUP_OF: Record<RoomDepartment, RoomGroup> = {
  "A&E": "ae",
  Inpatient: "wards",
  Diagnostics: "diagnostics",
  General: "shared",
  Any: "shared",
  Facilities: "facilities",
  Support: "support",
  Staff: "staff",
  Outpatients: "outpatients",
  Theatres: "theatres",
};
