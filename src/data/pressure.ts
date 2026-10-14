/**
 * Pressure events (GAME_DESIGN §9): what each does, when it comes and how
 * long it lasts. Balance by editing these. systems/pressure.ts runs them.
 *
 * Effects scale with the event's intensity, 0 to 1: a winter flu wave
 * builds, peaks and fades; a heatwave is at full strength throughout.
 */
import type { StaffRoleId } from "./schema";

export type PressureEventId =
  | "winter_surge"
  | "heatwave"
  | "major_incident"
  | "strike_resident_doctors"
  | "strike_consultants"
  | "strike_nurses"
  | "strike_diagnostics"
  | "strike_facilities"
  | "social_care_crisis";

/**
 * Industrial action (systems/strikes.ts). A walkout: the roles don't come
 * in, except a share kept at work by derogations (life-preserving care).
 * Planned only: they still do emergency work but no clinics or planned lists
 * ("Christmas Day cover", as consultants have struck).
 */
export interface StrikeDef {
  roles: StaffRoleId[];
  mode: "walkout" | "planned_only";
  /** Share still at work under derogations. */
  derogation: number;
}

export interface PressureEventDef {
  id: PressureEventId;
  name: string;
  /** What's happening, for the Events tab. */
  description: string;
  /** What the player can do about it. */
  levers: string[];
  /** Months of the financial year it can start in (0 = April … 11 = March). */
  months: number[];
  /**
   * How often it comes at the realistic setting: the expected starts a
   * season (the months above) if nothing held them back. Only one of a kind
   * at a time, at most `maxPerSeason`, and `gapDays` apart, so fewer come.
   */
  perSeason: number;
  maxPerSeason: number;
  gapDays: number;
  /** Notice before it starts (forecasts, surveillance, alerts), days. */
  leadDays: number;
  /**
   * Instead: it happens at a random time of day, with this many minutes'
   * notice (a major incident's "standby").
   */
  leadMins?: number;
  /** How long it lasts, days… */
  days: [number, number];
  /** …or hours, for something short. */
  hours?: [number, number];
  /** Builds to a peak and fades (a wave), or full strength throughout. */
  shape: "wave" | "flat";
  /** Arrival multipliers at full intensity. */
  arrivals: { walk_in: number; ambulance: number };
  /** Condition mix at full intensity: weight multipliers by condition id. */
  conditions: Record<string, number>;
  /** Staff sickness multiplier at full intensity (before flu vaccination). */
  sickness: number;
  /** Heat: patients and staff in rooms without cooling suffer (see HEAT). */
  heat: boolean;
  /** Social care takes this many times as long to arrange (data/discharge.ts). */
  careDelay?: number;
  /** Industrial action: who strikes, and how. */
  strike?: StrikeDef;
  /** The hour it starts on its first day (default 08:00; strikes start at 07:00). */
  startHour?: number;
  /** A short name for the top bar. */
  short: string;
}

export const PRESSURE_EVENTS: PressureEventDef[] = [
  {
    id: "winter_surge",
    name: "Winter pressures: flu season",
    short: "Flu season",
    description:
      "Flu and other winter viruses are spreading. More people come by ambulance, many of them older and short of breath; more need admitting, and they stay longer. Staff catch it too.",
    levers: [
      "Open escalation beds (Hospital → Escalation)",
      "Stand planned operations down to free beds and staff (Hospital → Departments)",
      "Fill rota gaps from the bank and agencies (Hospital → Policies)",
      "Vaccinate staff against flu in the autumn (Hospital → Policies)",
      "Discharge before noon to free beds earlier",
    ],
    // December to February.
    months: [8, 9, 10],
    // A flu season in about 90% of winters.
    perSeason: 2.3,
    maxPerSeason: 1,
    gapDays: 60,
    leadDays: 7,
    days: [28, 56],
    shape: "wave",
    arrivals: { walk_in: 1.05, ambulance: 1.15 },
    conditions: { shortness_of_breath: 2.2, sepsis: 1.4, elderly_fall: 1.3, minor_illness: 1.4 },
    sickness: 1.8,
    heat: false,
  },
  {
    id: "heatwave",
    name: "Heatwave: amber heat-health alert",
    short: "Heatwave",
    description:
      "The UK Health Security Agency has issued an amber heat-health alert. Older people fall and get dehydrated, and A&E is busier. Rooms without cooling get hot: patients waiting and on wards are uncomfortable, and staff tire faster.",
    levers: [
      "Put portable air conditioners in waiting areas, wards and bays (Equipment → Facilities)",
      "Water coolers keep waiting patients going",
      "Cover levels and bank staff for tired teams (Staff → Rota)",
    ],
    // June to August.
    months: [2, 3, 4],
    // About one and a half a summer, as UK summers have lately.
    perSeason: 2,
    maxPerSeason: 3,
    gapDays: 14,
    leadDays: 2,
    days: [3, 6],
    shape: "flat",
    arrivals: { walk_in: 1.1, ambulance: 1.08 },
    conditions: { elderly_fall: 1.4, minor_illness: 1.5, shortness_of_breath: 1.2 },
    sickness: 1,
    heat: true,
  },
  {
    id: "major_incident",
    name: "Major incident",
    short: "Major incident",
    description:
      "The ambulance service has declared a major incident nearby. A wave of casualties is on its way: a few critically injured (P1) for Resus, more seriously hurt (P2) for Majors, and walking wounded (P3) who'll make their own way in.",
    levers: [
      "Declare a major incident: call in off-duty staff, stand down clinics and planned operations, open escalation beds and discharge everyone fit to go",
      "Clear Resus and Majors for the critically injured",
      "Stand down once A&E has recovered: called-in staff go home and planned care resumes",
    ],
    // Any time of year: a hospital declares one for mass casualties every two or three years.
    months: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    perSeason: 0.4,
    maxPerSeason: 1,
    gapDays: 120,
    leadDays: 0,
    leadMins: 45,
    days: [0, 0],
    hours: [2, 4],
    shape: "flat",
    arrivals: { walk_in: 1, ambulance: 1 },
    conditions: {},
    sickness: 1,
    heat: false,
  },
];

PRESSURE_EVENTS.push({
  id: "social_care_crisis",
  name: "Social care crisis",
  short: "Social care crisis",
  description:
    "Care homes have closed to admissions and home care agencies are short of carers. Patients who need care to go home wait much longer for it, holding ward beds, and A&E backs up behind them.",
  levers: [
    "Discharge Coordinators ask for care from the day a patient is admitted, so less of the wait comes after they're fit (Staff → Hire)",
    "A Discharge Lounge frees beds hours earlier for everyone else going home",
    "Open escalation beds for the patients stuck in A&E (Hospital → Escalation)",
    "Discharge before noon (Hospital → Policies)",
  ],
  // Over Christmas and New Year most winters, and now and then at other times.
  months: [8, 9],
  perSeason: 1,
  maxPerSeason: 1,
  gapDays: 60,
  leadDays: 3,
  days: [21, 42],
  shape: "flat",
  arrivals: { walk_in: 1, ambulance: 1 },
  conditions: {},
  sickness: 1,
  heat: false,
  careDelay: 2.5,
});

/** Industrial action: any time of year, with the two weeks' notice the law requires. */
function strike(
  id: PressureEventId,
  name: string,
  short: string,
  perYear: number,
  days: [number, number],
  strikeDef: StrikeDef,
  description: string,
  levers: string[],
): PressureEventDef {
  return {
    id,
    name,
    short,
    description,
    levers,
    months: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    perSeason: perYear,
    maxPerSeason: 3,
    gapDays: 30,
    leadDays: 14,
    days,
    shape: "flat",
    arrivals: { walk_in: 1, ambulance: 1 },
    conditions: {},
    sickness: 1,
    heat: false,
    strike: strikeDef,
    startHour: 7,
  };
}

PRESSURE_EVENTS.push(
  strike(
    "strike_resident_doctors",
    "Industrial action: resident doctors",
    "Doctors' strike",
    0.5,
    [2, 5],
    { roles: ["junior_doctor", "registrar"], mode: "walkout", derogation: 0 },
    "Resident (junior) doctors and registrars are on strike. Consultants act down to cover their work in A&E and on the wards, at the BMA rate card, and on-call consultants come in for A&E work too.",
    [
      "Stand planned operations and clinics down, so consultants are free to cover A&E and the wards (Hospital → Departments)",
      "Emergency Nurse Practitioners see and treat minor injuries without a doctor",
      "Agencies won't supply locums to cover strikers",
    ],
  ),
  strike(
    "strike_consultants",
    "Industrial action: consultants",
    "Consultants' strike",
    0.15,
    [2, 2],
    { roles: ["consultant"], mode: "planned_only", derogation: 0 },
    "Consultants are on strike with 'Christmas Day cover': they still see emergencies and inpatients, but clinics and planned operations don't run.",
    [
      "Nothing to stand down: clinics and planned lists are cancelled and rebooked",
      "Patients due for planned care wait longer: watch the 18-week figures",
    ],
  ),
  strike(
    "strike_nurses",
    "Industrial action: nurses",
    "Nurses' strike",
    0.25,
    [1, 2],
    { roles: ["nurse", "nurse_practitioner"], mode: "walkout", derogation: 0.5 },
    "Nurses are on strike. Under the derogations agreed with the union, about half stay at work on life-preserving care; the rest walk out.",
    [
      "Stand planned care down to put the nurses still at work where they're needed most",
      "Divert ambulances if A&E can't cope (Hospital → Departments)",
      "Bank and agency staff can't be used to cover strikers",
    ],
  ),
  strike(
    "strike_diagnostics",
    "Industrial action: radiographers and biomedical scientists",
    "Diagnostics strike",
    0.15,
    [1, 3],
    { roles: ["radiographer", "biomedical_scientist"], mode: "walkout", derogation: 0.5 },
    "Radiographers and biomedical scientists are on strike, with about half providing emergency cover. X-rays, scans and blood results take longer.",
    ["Stand planned care down to keep the scanners and the lab for emergencies"],
  ),
  strike(
    "strike_facilities",
    "Industrial action: porters and cleaners",
    "Facilities strike",
    0.2,
    [3, 7],
    { roles: ["porter", "cleaner"], mode: "walkout", derogation: 0 },
    "Porters and cleaners are on strike. Admitted patients wait in A&E for someone to take them up to the ward, and cubicles and toilets wait to be cleaned.",
    [
      "Stand planned care down to ease the pressure on beds",
      "Open escalation beds for patients stuck in A&E (Hospital → Escalation)",
    ],
  ),
);

export const pressureEventById = new Map(PRESSURE_EVENTS.map((e) => [e.id, e]));

/** How often events come: off, half, the realistic rate, or twice it. */
export type EventFrequency = "off" | "rare" | "realistic" | "frequent";

/** The event-frequency setting, as a multiple of the realistic rate. */
export const EVENT_FREQUENCY: Record<EventFrequency, number> = {
  off: 0,
  rare: 0.5,
  realistic: 1,
  frequent: 2,
};

/** Heat in a room without cooling, at full intensity. */
export const HEAT = {
  /** Floor tiles one portable air conditioner keeps cool. */
  tilesPerCooler: 30,
  /** Extra mood lost an hour by patients waiting or in a cubicle… */
  moodPerHour: 6,
  /** …less this much with drinking water in the room. */
  waterRelief: 4,
  /** Where an inpatient's mood settles is this much lower. */
  wardMood: 15,
  /** Extra fatigue an hour for staff on site. */
  fatiguePerHour: 1.5,
};

/**
 * Staff flu vaccination (a policy): each autumn's campaign costs this much a
 * head (vaccine, occupational health time), and cuts the extra sickness a
 * flu season brings by `protection`. NHS staff uptake is around half.
 */
export const FLU_VACCINATION = {
  costPerHead: 15,
  protection: 0.5,
  /** The campaign runs from October (month 6 of the financial year). */
  month: 6,
};

/** Major incidents (systems/majorIncident.ts). */
export const MAJOR_INCIDENT = {
  /** Casualties coming here, and their mix (the rest are walking wounded, P3). */
  casualties: [10, 30] as [number, number],
  p1Share: 0.15,
  p2Share: 0.35,
  /** Walking wounded: minor injuries who make their own way in. */
  walkingWounded: ["laceration", "sprained_ankle", "minor_head_injury", "broken_ankle"],
  /** What happened, for the standby message. */
  causes: [
    "a multi-vehicle collision on the motorway",
    "a fire in a block of flats",
    "a crowd crush at a concert",
    "a train derailment",
    "an explosion at an industrial site",
    "a coach crash on the bypass",
  ],
  /** Declaring: each off-duty member of staff answers the call with this chance… */
  respondChance: 0.6,
  /** …and arrives this many minutes later. */
  arriveMins: [30, 90] as [number, number],
  /** Called-in staff are paid at time and a half on top of their salary's hours. */
  overtimeRate: 1.5,
  /** Planned care stands down; ward patients due home within this many hours are reviewed now. */
  rapidDischargeHours: 24,
  /** Stood down automatically this long after the last casualty, if the player hasn't. */
  autoStandDownHours: 12,
};

/** Industrial action (systems/strikes.ts). */
export const STRIKES = {
  /** Consultants covering residents' work earn this much an hour on site, on top (the BMA rate card). */
  actingDownHourly: 160,
};
