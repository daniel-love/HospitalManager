/**
 * Pressure events (GAME_DESIGN §9): what each does, when it comes and how
 * long it lasts. Balance by editing these. systems/pressure.ts runs them.
 *
 * Effects scale with the event's intensity, 0 to 1: a winter flu wave
 * builds, peaks and fades; a heatwave is at full strength throughout.
 */
export type PressureEventId = "winter_surge" | "heatwave";

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
  /** How long it lasts, days. */
  days: [number, number];
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
}

export const PRESSURE_EVENTS: PressureEventDef[] = [
  {
    id: "winter_surge",
    name: "Winter pressures: flu season",
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
];

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
