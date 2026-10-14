/**
 * SimState is the whole simulation as plain, serialisable data: no class
 * instances, no Pixi objects, no functions. It doubles as the save schema
 * (see save/codec.ts), except for fields marked "derived", which are rebuilt
 * after loading.
 */
import { REPUTATION, STARTING_CASH } from "@data/economy";
import { GRANT_OFFERS, OVERSIGHT, START_CREDIT } from "@data/finance";
import type { SpecialtyId } from "@data/schema";
import { DEFAULT_CATCHMENT } from "@data/patients";
import {
  type Ambulance,
  type Collection,
  type Operation,
  type Outpatient,
  type Referral,
  emptyFlows,
  emptyLedger,
  emptyStats,
  type DayReport,
  type FlowStats,
  type Incident,
  type Job,
  type Grant,
  type Ledger,
  type Loan,
  type MonthReport,
  type Patient,
  type SimEvent,
  type Staff,
} from "./agents";
import type { PlanEntry } from "./plan";
import { createRng, type RngState } from "./rng";
import { TICKS_PER_DAY } from "./time";
import { createFloorGrid, type FloorGrid } from "./world/grid";
import type { Rect } from "./world/rect";
import { layOutSite, type Site } from "./world/site";

export const SIM_STATE_VERSION = 32;

/** Quarter turns clockwise. */
export type Rotation = 0 | 1 | 2 | 3;

/** A placed piece of equipment or a door. Covers every tile of its footprint. */
export interface PlacedObject {
  id: number;
  defId: string;
  floor: number;
  /** Top-left tile of the rotated footprint. */
  x: number;
  y: number;
  rotation: Rotation;
}

export interface RoomCheck {
  label: string;
  ok: boolean;
  /** Extra detail, e.g. "4 of 6". */
  detail?: string;
}

/** A detected room: a connected area of one zone type, bounded by walls and doors. */
export interface Room {
  /** Matches FloorGrid.roomId. Reassigned whenever rooms are re-detected. */
  id: number;
  floor: number;
  typeId: string;
  /** Tile indices into the floor grid. */
  tiles: number[];
  bounds: Rect;
  /** Objects wholly inside the room. */
  objectIds: number[];
  capabilities: string[];
  checks: RoomCheck[];
  valid: boolean;
  /** Wards and clinic rooms: the specialty it's for (see SimState.roomSpecialties), or null for any. */
  specialty: SpecialtyId | null;
  /** Operating theatres: kept for emergencies (see SimState.emergencyTheatres). */
  emergency: boolean;
  /** Hybrid trusts: part of the Private Patient Unit (see SimState.privateRooms). */
  private: boolean;
  /**
   * Advisory: equipment some conditions need here, beyond being valid
   * (e.g. an ECG for chest pain). Doesn't affect `valid`.
   */
  forConditions: RoomCheck[];
}

export interface SimState {
  version: number;
  seed: number;
  rng: RngState;
  /** Ticks elapsed since the game started. */
  tick: number;
  /** Cash in £. Can't go below zero through building. */
  money: number;
  /** One grid per floor; index 0 is the ground floor. */
  floors: FloorGrid[];
  /** The public road and pavements (world/site.ts); null on a blank map. */
  site: Site | null;
  /** Keyed by object id. */
  objects: Record<number, PlacedObject>;
  nextObjectId: number;
  /** Build plan (blueprint) not yet built or paid for. See plan.ts. */
  plan: PlanEntry[];
  /** Bumped by every layout change, so agents know to re-plan their routes. */
  layoutVersion: number;

  patients: Record<number, Patient>;
  staff: Record<number, Staff>;
  /** Shared id sequence for patients and staff. */
  nextAgentId: number;
  jobs: Record<number, Job>;
  nextJobId: number;
  /** Ambulances parked or waiting outside, keyed by id. */
  ambulances: Record<number, Ambulance>;
  nextAmbulanceId: number;
  /** Funeral directors collecting from the mortuary, keyed by id. */
  collections: Record<number, Collection>;
  nextCollectionId: number;
  /**
   * Outpatient waiting lists (systems/referrals.ts): GP referrals waiting
   * for a first appointment, follow-ups, and patients waiting for surgery.
   */
  referrals: Record<number, Referral>;
  nextReferralId: number;
  /** People in for an outpatient appointment today, keyed by id (agent ids). */
  outpatients: Record<number, Outpatient>;
  /** Operations under way, keyed by id (systems/theatres.ts). */
  operations: Record<number, Operation>;
  nextOperationId: number;
  /**
   * Who has claimed what: "objectId:slot" → agent id. Slots are seats on a
   * bench, 0 for a couch or toilet, "staff" for the staff side of a desk.
   */
  reserved: Record<string, number>;
  /** Uses since last cleaned, by object id (couches and toilets). */
  dirt: Record<number, number>;
  /**
   * Wards and clinic rooms given to a specialty, keyed "floor:tile" by one of their
   * tiles. Room ids change whenever rooms are re-detected, so the setting
   * is pinned to a tile and found again from it (detectRooms).
   */
  roomSpecialties: Record<string, SpecialtyId>;
  /** Operating theatres kept for emergencies, pinned to a tile like roomSpecialties. */
  emergencyTheatres: Record<string, true>;
  /** Hybrid trusts: rooms in the Private Patient Unit, pinned to a tile like roomSpecialties. */
  privateRooms: Record<string, true>;
  /** Each department's status (GAME_DESIGN §8.3): open, or less than fully open. */
  departments: Departments;
  /** How the hospital is funded (GAME_DESIGN §2.2), chosen when the game starts. */
  funding: Funding;
  /** 0–100: what patients and GPs think of the hospital (systems/reputation.ts). */
  reputation: number;
  /**
   * Cover levels (systems/rota.ts): how many of each rota group the player
   * wants on each day and night shift, keyed by group ("nurse",
   * "registrar:cardiology"). Groups with none set share shifts out evenly.
   */
  cover: Record<string, Cover>;
  /** Hospital policies (GAME_DESIGN §8.4). */
  policies: Policies;

  /** Money and patient flow so far today, and reports for past days (newest last). */
  today: { ledger: Ledger; stats: FlowStats };
  history: DayReport[];
  /**
   * The monthly financial statement: this month so far (filed days only),
   * and past months (newest last). See systems/finance.ts closeMonth.
   */
  month: MonthReport;
  months: MonthReport[];
  /** Loans outstanding (systems/loans.ts). */
  loans: Loan[];
  nextLoanId: number;
  /** How lenders and regulators see the hospital's finances (systems/loans.ts). */
  rating: Rating;
  /** A grant on offer, those taken on, and those finished (systems/grants.ts). */
  grants: {
    offer: Grant | null;
    active: Grant[];
    /** When the next offer comes. */
    nextOffer: number;
    /** Finished grants, newest last: met (kept) or missed (clawed back). */
    done: { defId: string; tick: number; met: boolean }[];
  };
  settings: SimSettings;
  /** Tick each kind of warning was last raised, so they aren't repeated constantly. */
  alerts: Record<string, number>;
  /** Patient safety incidents, oldest first (capped; see MAX_INCIDENTS). */
  incidents: Incident[];
  nextIncidentId: number;

  /** Not saved: messages for the notifications feed, drained by the game each frame. */
  events: SimEvent[];
  /** Derived (not saved): rebuilt by detectRooms() after every layout change. */
  rooms: Room[];
  /** Derived (not saved): room id holding each object wholly inside a room. */
  objectRoom: Record<number, number>;
}

/** Sandbox difficulty knobs (GAME_DESIGN §2.4). */
export interface SimSettings {
  /** People the hospital serves (see data/patients.ts CATCHMENTS): sets demand. */
  catchment: number;
  /** Multiplies arrival rates on top of the catchment's: 1 = real-world per-person rates. */
  patientVolume: number;
  /**
   * Staff work shifts and rotas (systems/rota.ts). Off, everyone hired works
   * around the clock: saves from before rotas, and test fixtures.
   */
  rotas: boolean;
}

/**
 * How rota gaps are filled at the start of a shift: not at all, from the
 * staff bank, or from the bank and then an agency (systems/workforce.ts).
 */
export type GapFill = "none" | "bank" | "bank_agency";

export interface Policies {
  gapFill: GapFill;
  /** Private care: the self-pay price level, as a multiple of the standard price (PRIVATE.priceLevels). */
  priceLevel: number;
  /** Private Hospitals: specialties taking NHS-funded referrals (patient choice), at tariff. */
  nhsReferrals: Partial<Record<SpecialtyId, true>>;
}

/**
 * Department statuses (GAME_DESIGN §8.3), a crisis lever. A&E on divert
 * takes no ambulances (walk-ins still come); closed, it takes nobody.
 * Outpatients taking urgent referrals only turns routine GP referrals away;
 * closed, its clinics don't run. Theatres for emergencies only stand their
 * planned lists down; closed, they don't operate at all.
 */
export interface Departments {
  ae: "open" | "divert" | "closed";
  outpatients: "open" | "urgent" | "closed";
  theatres: "open" | "emergency" | "closed";
}

/**
 * An NHS trust's oversight segment (1 best to 4, financial special measures),
 * and a Private Hospital's credit rating (an index into CREDIT_RATINGS, 0
 * best) and administration. Each is reviewed monthly.
 */
export interface Rating {
  segment: number;
  credit: number;
  /** A Private Hospital in administration: when it went in. Null otherwise. */
  administration: number | null;
  /** A Private Hospital with cash below zero: since when. Null otherwise. */
  overdrawnSince: number | null;
}

/**
 * NHS Trust: NHS funding only. Private Hospital: private patients (and NHS
 * referrals it chooses to take), consultants with practising privileges, no
 * emergency department. Hybrid: an NHS trust with a Private Patient Unit.
 */
export type Funding = "nhs" | "private" | "hybrid";

/** People wanted on each day shift and each night shift. */
export interface Cover {
  day: number;
  night: number;
}

export interface NewGameOptions {
  seed: number;
  width?: number;
  height?: number;
  money?: number;
  /** Lay out the public road (world/site.ts). Off for blank test maps. */
  site?: boolean;
  /** Staff work shifts. Off for test maps, where everyone works around the clock. */
  rotas?: boolean;
  funding?: Funding;
}

export const DEFAULT_MAP_SIZE = 200;

/** A month with nothing in it yet, opening with `cash`. */
export function emptyMonth(monthIndex: number, cash: number): MonthReport {
  return {
    monthIndex,
    days: 0,
    ledger: emptyLedger(),
    stats: emptyStats(),
    openingCash: cash,
    closingCash: cash,
    flows: emptyFlows(),
  };
}

export function createSimState(opts: NewGameOptions): SimState {
  const width = opts.width ?? DEFAULT_MAP_SIZE;
  const height = opts.height ?? DEFAULT_MAP_SIZE;
  const ground = createFloorGrid(width, height);
  return {
    version: SIM_STATE_VERSION,
    seed: opts.seed >>> 0,
    rng: createRng(opts.seed),
    tick: 0,
    money: opts.money ?? STARTING_CASH,
    floors: [ground],
    site: opts.site ? layOutSite(ground) : null,
    objects: {},
    nextObjectId: 1,
    plan: [],
    layoutVersion: 0,
    patients: {},
    staff: {},
    nextAgentId: 1,
    jobs: {},
    nextJobId: 1,
    ambulances: {},
    nextAmbulanceId: 1,
    collections: {},
    referrals: {},
    nextReferralId: 1,
    outpatients: {},
    operations: {},
    nextOperationId: 1,
    nextCollectionId: 1,
    reserved: {},
    dirt: {},
    roomSpecialties: {},
    emergencyTheatres: {},
    privateRooms: {},
    departments: { ae: "open", outpatients: "open", theatres: "open" },
    funding: opts.funding ?? "nhs",
    reputation: REPUTATION.start,
    cover: {},
    policies: { gapFill: "bank", priceLevel: 1, nhsReferrals: {} },
    today: { ledger: emptyLedger(), stats: emptyStats() },
    history: [],
    month: emptyMonth(0, opts.money ?? STARTING_CASH),
    months: [],
    loans: [],
    nextLoanId: 1,
    rating: {
      segment: OVERSIGHT.start,
      credit: START_CREDIT,
      administration: null,
      overdrawnSince: null,
    },
    grants: {
      offer: null,
      active: [],
      nextOffer: GRANT_OFFERS.everyDays[0] * TICKS_PER_DAY,
      done: [],
    },
    settings: { catchment: DEFAULT_CATCHMENT, patientVolume: 1, rotas: opts.rotas ?? false },
    alerts: {},
    incidents: [],
    nextIncidentId: 1,
    events: [],
    rooms: [],
    objectRoom: {},
  };
}
