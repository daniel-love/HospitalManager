/**
 * Agents (patients and staff) and the job board, as plain serialisable data
 * stored in SimState (ARCHITECTURE §4.1). Systems in sim/systems/ update them
 * each tick.
 *
 * Positions are in tiles, where whole numbers are tile centres: an agent at
 * (3, 4) stands in the middle of tile (3, 4). Agents never block each other.
 */
import type { StaffRoleId } from "@data/schema";

export interface Point {
  x: number;
  y: number;
}

/** Where an agent is heading: `approach` is the tile it walks to, then it steps to (x, y). */
export interface Destination extends Point {
  ax: number;
  ay: number;
  /** Tick a route search last failed, or -1. Retried after a while. */
  blocked: number;
}

export interface AgentBase extends Point {
  id: number;
  name: string;
  /** Position at the start of this tick, for smooth drawing between ticks. */
  prevX: number;
  prevY: number;
  /** Remaining waypoints as [x0, y0, x1, y1, …]. */
  path: number[];
  dest: Destination | null;
  /** SimState.layoutVersion the path was found for; stale paths are re-planned. */
  pathVersion: number;
}

export type PatientStage =
  /** Brought by ambulance: on the crew's stretcher, waiting to be handed over. */
  | "awaiting_handover"
  /** Walking in and queueing at A&E reception. */
  | "queueing"
  /** At the desk, being booked in. */
  | "booking"
  | "waiting_triage"
  /** Called by a triage nurse and walking to the triage room. */
  | "called_triage"
  | "triage"
  | "waiting_treatment"
  /** Called to a cubicle. */
  | "called_treatment"
  /** In a cubicle: being treated, or waiting there for the next step. */
  | "in_cubicle"
  /** Cardiac arrest: the crash team is resuscitating them where they fell. */
  | "collapsed"
  /** Decision to admit: on their A&E trolley until a porter takes them to a ward bed. */
  | "awaiting_bed"
  /** Being wheeled to the ward by a porter. */
  | "transferring"
  /** An inpatient, in a ward bed, until they're well enough to go home. */
  | "on_ward"
  /** Has died: still where they died, until last offices and a porter. */
  | "deceased"
  /** Being taken to the mortuary on a covered trolley. */
  | "to_mortuary"
  /** In the mortuary until the Medical Examiner (and coroner) release them. */
  | "in_mortuary"
  /** Heading out of the building. */
  | "leaving";

/**
 * transferred: to intensive care. transferred_out: needed admitting, but the
 * hospital has no ward, so they went to another hospital's.
 */
export type Outcome = "discharged" | "lwbs" | "transferred" | "transferred_out" | "died";

/**
 * After a death (GAME_DESIGN §5.6): each step of the process, as the tick it
 * was done (null until then).
 */
export interface Death {
  tick: number;
  /** An end-of-life patient, rather than after a failed resuscitation. */
  expected: boolean;
  /** Where they died, e.g. "Majors Bay". */
  where: string;
  verified: number | null;
  /** The family told (for expected deaths they were there: set at once). */
  familyTold: number | null;
  lastOffices: number | null;
  inMortuary: number | null;
  /** Their space in the mortuary: fridge unit and slot. */
  fridge: { objectId: number; slot: number } | null;
  meReviewed: number | null;
  /** Referred to the coroner, which delays release by days. */
  coroner: boolean;
  /** When the funeral director collects them. */
  releaseAt: number | null;
}

/**
 * A patient who is getting worse (GAME_DESIGN §5.2, §7). Ticks: warning signs
 * from `onset`; collapse at `crash` unless a stabilising step comes first.
 * Once they've collapsed, `crash` is when it happened.
 */
export interface Deterioration {
  onset: number;
  crash: number;
  /** When a member of staff spotted it and escalated, or null. */
  noticed: number | null;
}

/** A reserved seat: the seating object and which seat on it. */
export interface Seat {
  objectId: number;
  slot: number;
}

export interface Patient extends AgentBase {
  conditionId: string;
  /** Manchester Triage category once triaged; 0 before. */
  category: number;
  stage: PatientStage;
  /** Index of the pathway step being done or waited for. */
  step: number;
  seat: Seat | null;
  /** Where they stand in the waiting area when there's no free seat. */
  standing: Point | null;
  /** Couch reserved for triage or treatment. */
  bed: number | null;
  /** Reception desk they're being booked in at. */
  desk: number | null;
  /** Ticks of booking left (-1 when not booking). */
  bookingLeft: number;
  /** Toilet trip in progress: the toilet, and ticks left once there (-1 = walking). */
  toilet: { objectId: number; left: number } | null;
  /** 0 (furious) to 100 (content). At low mood walk-ins may leave without being seen. */
  mood: number;
  /** The ambulance that brought them, or null for walk-ins. */
  ambulanceId: number | null;
  /** Getting worse (or due to), until a stabilising step; null otherwise. */
  deterioration: Deterioration | null;
  /** Last set of observations: when, and the early warning score (NEWS2). */
  obs: { tick: number; news: number } | null;
  /** 0–100; they look for a toilet when it's high. */
  bladder: number;
  /** Bladder rise per tick. */
  bladderRate: number;
  /** Tick timestamps (null until it happens). */
  times: {
    arrived: number;
    booked: number | null;
    triaged: number | null;
    /** First seen by a treating clinician. */
    seen: number | null;
    /** Decision to admit to a ward. */
    decided: number | null;
    /** Arrived on the ward (left A&E). */
    admitted: number | null;
    left: number | null;
  };
  /** Inpatients: the tick they'll be well enough for the discharge review. */
  stayUntil: number | null;
  /** Admitted for end-of-life care: they'll die (expectedly) on the ward. */
  endOfLife: boolean;
  death: Death | null;
  outcome: Outcome | null;
}

export interface Staff extends AgentBase {
  role: StaffRoleId;
  jobId: number | null;
  /** Receptionists: the desk they staff. Nurses: the nurse station they wait at. */
  desk: number | null;
  hiredTick: number;
  /** 0–100. Falls after deaths they're involved in; recovers slowly. (Effects from M5.) */
  morale: number;
}

/**
 * transfer: a porter wheels an admitted patient to the ward bed in
 * `objectId`. ward_discharge: a doctor's review before an inpatient goes home.
 * handover: a nurse takes over an ambulance patient from the crew (and
 * triages them), at a trolley or, if they can sit, where they are. obs:
 * observations, wherever the patient is. resus: a crash call; the lead (a
 * doctor) and support (a nurse) each have a job.
 */
export type JobKind =
  | "transfer"
  | "ward_discharge"
  | "handover"
  | "triage"
  | "treat"
  | "obs"
  | "resus"
  | "clean_cubicle"
  | "clean_toilet"
  | "verify_death"
  | "break_news"
  | "last_offices"
  | "to_mortuary"
  | "me_review"
  | "debrief";

/** A tile rectangle where one ambulance parks. */
export interface ParkingSpace {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * An ambulance bringing a patient (GAME_DESIGN §5.1). With no free space in
 * an Ambulance Bay it waits outside, crew and patient on board; the handover
 * clock runs from arrival either way.
 */
export interface Ambulance {
  id: number;
  /** Tick it reached the hospital (came onto the map, on a map with a road). */
  arrived: number;
  /**
   * arriving: driving in, or queueing on the road for a space; parked: at its
   * space with the patient; leaving: driving off the map.
   */
  phase: "arriving" | "parked" | "leaving";
  /** Its space (driving to it, or parked), or null while it waits for one or leaves. */
  space: ParkingSpace | null;
  /** Centre tile, now and at the previous tick (for smooth drawing). */
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** Tiles still to drive through, flattened [x0, y0, x1, y1, ...]. */
  route: number[];
  /** Layout version the route was planned on. */
  routeVersion: number;
  /** The end of the road it came in from: 0 west, 1 east. */
  from: 0 | 1;
  patientId: number | null;
  /** Tick the crew handed over, or null. */
  handedOver: number | null;
  /** Tick it drives off (after handover and turnaround), or null. */
  leaveAt: number | null;
}

/**
 * A unit of work on the job board (ARCHITECTURE §4.3). Systems post jobs;
 * idle staff with the right role claim the most urgent one they can do.
 */
export interface Job {
  id: number;
  kind: JobKind;
  /** Roles that can do it, most preferred first (see PathwayStep.roles). */
  roles: StaffRoleId[];
  patientId: number | null;
  /**
   * The couch or toilet the work happens at. Null until claimed for triage
   * and first treatment steps: the place is chosen when a clinician is free.
   */
  objectId: number | null;
  /** Room type a place must be in (when objectId is null). */
  roomType: string;
  /** Capabilities that room needs beyond being valid. */
  capabilities: string[];
  /**
   * Pathway step, for treatment jobs. For resus, 0 = lead and 1 = support.
   * For transfer, 1 = wheeled on their trolley, 0 = walking.
   */
  step: number;
  /** Lower is more urgent: the tick it should have started by. */
  dueTick: number;
  durationTicks: number;
  /** Ticks worked so far. */
  progress: number;
  staffId: number | null;
  state: "open" | "assigned" | "working";
  createdTick: number;
}

/** Money in and out over a period, £. */
export interface Ledger {
  tariff: number;
  salaries: number;
  upkeep: number;
}

/** Patient flow counts over a period. Times are in minutes. */
export interface FlowStats {
  arrivals: number;
  discharged: number;
  lwbs: number;
  /** Transferred to intensive care after a cardiac arrest. */
  transferred: number;
  /** Patient safety incidents raised. */
  incidents: number;
  ambulances: number;
  /** Ambulances that ambulance control sent elsewhere because crews were queueing here. */
  deflected: number;
  handovers: number;
  /** Sum of arrival-to-handover times, for an average. */
  handoverMins: number;
  /** Handovers that took over 30 and over 60 minutes. */
  handoversOver30: number;
  handoversOver60: number;
  /** Patients admitted to a ward (counted when they reach it). */
  admissions: number;
  /** Sum of decision-to-admit to leaving-A&E waits, for an average. */
  bedWaitMins: number;
  /** "Trolley waits": decision to admit to leaving A&E over 4 and over 12 hours. */
  bedWaitsOver4h: number;
  bedWaitsOver12h: number;
  /** Inpatients discharged home from a ward. */
  wardDischarges: number;
  /** Needed a ward bed, but the hospital has no ward: sent to another hospital. */
  transfersOut: number;
  deaths: number;
  /** Deaths after a failed resuscitation (the rest were expected). */
  unexpectedDeaths: number;
  /** Complaints about how a death was handled (no side room, no relatives' room, public route). */
  complaints: number;
  /** Departures (discharge or LWBS) within 4 hours of arrival. */
  within4h: number;
  departures: number;
  triaged: number;
  /** Sum of arrival-to-triage waits, for an average. */
  triageWaitMins: number;
  /** Sum of arrival-to-departure times. */
  timeInDeptMins: number;
}

export interface DayReport {
  day: number;
  ledger: Ledger;
  stats: FlowStats;
}

export function emptyLedger(): Ledger {
  return { tariff: 0, salaries: 0, upkeep: 0 };
}

export function emptyStats(): FlowStats {
  return {
    arrivals: 0,
    discharged: 0,
    lwbs: 0,
    transferred: 0,
    incidents: 0,
    ambulances: 0,
    deflected: 0,
    handovers: 0,
    handoverMins: 0,
    handoversOver30: 0,
    handoversOver60: 0,
    admissions: 0,
    bedWaitMins: 0,
    bedWaitsOver4h: 0,
    bedWaitsOver12h: 0,
    wardDischarges: 0,
    transfersOut: 0,
    deaths: 0,
    unexpectedDeaths: 0,
    complaints: 0,
    within4h: 0,
    departures: 0,
    triaged: 0,
    triageWaitMins: 0,
    timeInDeptMins: 0,
  };
}

export function net(l: Ledger): number {
  return l.tariff - l.salaries - l.upkeep;
}

/**
 * A patient safety incident record (GAME_DESIGN §5.6), with the contributing
 * factors in plain English.
 */
export interface Incident {
  id: number;
  tick: number;
  patientId: number;
  patientName: string;
  conditionId: string;
  /** One-line summary, e.g. "Cardiac arrest after unnoticed deterioration". */
  summary: string;
  /** Where it happened, e.g. "Majors Bay". */
  where: string;
  at: Point;
  causes: string[];
}

/** A message for the notifications feed. Never read back by the sim. */
export interface SimEvent {
  tick: number;
  text: string;
  severity: "info" | "warn" | "bad";
  /** Where to jump the camera, in tiles. */
  at?: Point;
}
