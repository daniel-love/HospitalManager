/**
 * Bridge from the game to the Preact UI. The game writes these signals (the
 * HUD a few times a second); components re-render when the values change.
 * UI-owned choices (selected tool, open panel) live here too, and the game
 * reads them.
 */
import { signal } from "@preact/signals";
import type { AdviceData } from "@game/advice";
import type { EventChip } from "@game/describeEvents";
import type { FinanceData } from "@game/describeFinance";
import type { HospitalData } from "@game/describeHospital";
import type { Speed } from "@game/loop";
import type { Tool } from "@game/tools";
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import type { CashFlows, DayReport, FlowStats, Ledger } from "@sim/agents";
import type { Funding, GapFill, Rotation, RoomCheck } from "@sim/state";
import type { NurseBand } from "@data/staff";
import type { HelpContent } from "./help";

export interface HudState {
  clock: string;
  speed: Speed;
  money: number;
  /** Patients in the department right now. */
  patients: number;
  /** Today's 4-hour performance (share leaving A&E within 4 hours), or null before anyone has. */
  fourHour: number | null;
  /** A Private Hospital in administration. */
  administration: boolean;
  /** Pressure events forecast or under way. */
  events: EventChip[];
  /** The CQC rating, once inspected, and whether inspectors are here now. */
  cqc: { rating: string | null; label: string | null; underWay: boolean };
}

export interface DebugStats {
  fps: number;
  frameMs: number;
  /** Longest gap between display refreshes in the last few seconds (stutter). */
  worstGapMs: number;
  /** Refresh gaps over 25 ms in the last few seconds. */
  longGaps: number;
  /** Most time our code spent in one refresh in the last few seconds. */
  worstWorkMs: number;
  simMs: number;
  ticksPerSec: number;
  ticksDropped: number;
  tick: number;
  seed: number;
  zoom: number;
  camera: { x: number; y: number };
  hoveredTile: { x: number; y: number } | null;
  chunksVisible: number;
  mapSize: { width: number; height: number };
  rooms: number;
  objects: number;
  patients: number;
  staff: number;
  jobs: number;
}

/** One step of the process after a death. `progress` is set for steps in hand. */
export interface DeathChecklistItem {
  label: string;
  done: boolean;
  detail?: string;
  progress?: "underway" | "waiting" | "blocked";
}

/** A patient or member of staff, for the inspector. */
export type AgentInfo =
  | {
      kind: "patient";
      id: number;
      name: string;
      condition: string;
      /** Triage category name and colour, once triaged. */
      category?: { label: string; colour: string; target: string; note: string };
      status: string;
      /** What's holding them up, if anything (see waitReason). */
      reason: string | null;
      /** Time since arrival, e.g. "1h 20m". */
      inDept: string;
      breached: boolean;
      mood: number;
      needs: string[];
      timeline: { label: string; at: string }[];
      /** After a death: each step of the process, and whether it's done. */
      afterDeath?: DeathChecklistItem[];
      /** After a death: the step in hand, and what (if anything) is holding it up. */
      deathStatus?: { progress: "underway" | "waiting" | "blocked"; reason: string };
      /** For patients who need monitoring. */
      monitoring?: {
        /** Last set of observations and its early warning score (NEWS2). */
        obs: { news: number; text: string; overdue: boolean } | null;
        /** Who can see them, e.g. "Watched from a staffed nurse station". */
        watch: string;
        /** Escalated or in cardiac arrest. */
        flag: string | null;
      };
    }
  | {
      kind: "outpatient";
      id: number;
      name: string;
      /** e.g. "Cardiology: first appointment (urgent)". */
      visit: string;
      status: string;
      /** e.g. "14:20 with Dr …". */
      appointment: string;
      /** Weeks on the 18-week clock, if it's running. */
      rtt: string | null;
    }
  | {
      kind: "staff";
      id: number;
      name: string;
      role: string;
      activity: string;
      annualCost: number;
      /** Their working pattern: rota shifts, weekdays, or on call. */
      rota: string;
      /** 0–100. */
      morale: number;
      skill: number;
      /** 0–100; null when rotas are off (nobody tires). */
      fatigue: number | null;
      /** Off sick, or working their notice: a line to show, if so. */
      notice: string | null;
      /** Resident consultants: whether they have the Medical Examiner duty. */
      meDuty?: boolean;
      /** Resident consultants and registrars of a specialty with clinics: their clinics. */
      clinics?: { sessions: number; max: number; note: string };
      /** Resident surgeons and anaesthetists: their theatre lists. */
      theatre?: { sessions: number; max: number; note: string };
      /** Hybrid trusts' employed consultants: private clinics and lists on top. */
      privateClinics?: { sessions: number; max: number; note: string };
      privateTheatre?: { sessions: number; max: number; note: string };
    };

export interface InspectorData {
  tile: { x: number; y: number };
  agent?: AgentInfo;
  room?: {
    name: string;
    department: string;
    description: string;
    size: string;
    valid: boolean;
    checks: RoomCheck[];
    /** Advisory equipment for some conditions (doesn't affect validity). */
    forConditions: RoomCheck[];
    /** Patients can only get here through another clinical room. */
    patientsCantReach: boolean;
    capabilities: string[];
    items: { name: string; count: number }[];
    /** Wards: the specialty it's for (null: any), and the choices. */
    specialty?: {
      value: SpecialtyId | null;
      options: { id: SpecialtyId; name: string }[];
      /** How the setting is used, for this kind of room. */
      note: string;
    };
    /** Operating theatres: kept for emergencies. */
    emergency?: boolean;
    /** Hybrid trusts: in the Private Patient Unit (rooms that can be). */
    private?: boolean;
    /** On the essential supply: the standby generators cover it first in a power cut. */
    essential?: boolean;
    /** Wards and side rooms: closed to admissions in an outbreak, and cases there now. */
    closure?: { closed: boolean; byTeam: boolean; cases: number };
  };
  object?: {
    id: number;
    movable: boolean;
    name: string;
    description: string;
    cost: number;
    upkeep?: number;
    /** Who uses which side, e.g. "Patients/visitors at the front (arrow); staff behind (blue)". */
    access?: string;
    capabilities: string[];
    /** Beds that should be watched: how well they are right now. */
    cover?: { text: string; ok: boolean };
    /** Equipment that can break down or needs power: its condition now. */
    condition?: { text: string; ok: boolean };
  };
}

export type BuildTab = "construction" | "rooms" | "equipment";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export const hud = signal<HudState>({
  clock: "",
  speed: 1,
  money: 0,
  patients: 0,
  fourHour: null,
  administration: false,
  events: [],
  cqc: { rating: null, label: null, underWay: false },
});
/** The player has seen the administration notice for this game and chosen to play on. */
export const administrationDismissed = signal(false);
export const debugStats = signal<DebugStats | null>(null);
export const debugVisible = signal<boolean>(false);

/** Selected build tool, or null for the normal select/pan cursor. */
export const tool = signal<Tool | null>(null);
/** Rotation applied to equipment placement (R key). */
export const rotation = signal<Rotation>(0);
/** Build menu tab whose palette is open, or null when closed. */
export const buildTab = signal<BuildTab | null>(null);
/** Tooltip next to the mouse describing what the tool would do. */
export const cursorInfo = signal<{ x: number; y: number; text: string; ok: boolean } | null>(null);
export const inspector = signal<InspectorData | null>(null);
export const saveDialogOpen = signal(false);
/** The New hospital dialog: choosing a funding model. */
export const newGameOpen = signal(false);

/** Management panel open on the left (closes the build palette). */
export type SidePanel = "reports" | "help";
export const sidePanel = signal<SidePanel | null>(null);
/** Help panel recommendations, while it's open. */
export const advice = signal<AdviceData | null>(null);

export interface Notification {
  id: number;
  /** In-game time, e.g. "Tue 2 Apr  14:05". */
  when: string;
  text: string;
  severity: "info" | "warn" | "bad";
  at?: { x: number; y: number };
  /** A staffing matter: opens the Staff screen at this tab (and person). */
  staff?: { tab: "team" | "rota"; id?: number };
  /** A money matter: opens the Finance dialog at this tab. */
  finance?: FinanceTab;
  /** A matter for the Hospital dialog: opens it at this tab. */
  hospital?: HospitalTab;
}
export const notifications = signal<Notification[]>([]);

export interface RosterData {
  /** Roles to hire, by staff group, in display order. */
  groups: { name: string; roles: RosterRole[] }[];
  /** Specialties consultants and registrars can be hired into. */
  specialties: { id: SpecialtyId; name: string; description: string }[];
  staff: { id: number; name: string; role: string; activity: string }[];
  /** Total staff cost per year. */
  payroll: number;
  /** Whether staff work shifts (a setting; off in saves from before rotas). */
  rotas: boolean;
  funding: Funding;
  /** How rota gaps are filled (a hospital policy). */
  gapFill: GapFill;
  /** Bank and agency staff at work now. */
  temps: { bank: number; agency: number };
  /** Each rota group's cover and how the rota meets it. */
  rota: RotaRow[];
}

export interface RotaRow {
  key: string;
  name: string;
  people: number;
  /** Wanted on each day and night shift; zeros when none set. */
  cover: { day: number; night: number };
  /** Average rostered on a day shift and on a night shift. */
  avgDay: number;
  avgNight: number;
  /** Fewest rostered on any day shift and any night shift. */
  minDay: number;
  minNight: number;
  /** Rostered on each of the week's 14 shifts: Monday day, Monday night, … */
  filled: number[];
  /** Shifts a week short of the cover. */
  gaps: number;
  /** People needed to meet the cover on contracted hours alone. */
  needed: number;
  onNow: number;
}

export interface RosterRole {
  id: StaffRoleId;
  name: string;
  description: string;
  annualCost: number;
  count: number;
  /** At work now (or in on call). */
  atWork: number;
  /** Hired into a specialty (consultants, registrars). */
  specialist: boolean;
  /** For specialists: how many of each specialty are on staff. */
  bySpecialty: Record<string, number> | null;
  /** Nurses: each band's title, pay and how many are on staff. */
  bands: { band: NurseBand; title: string; annualCost: number; count: number }[] | null;
}

/** A month's statement for the Reports panel. */
export interface StatementMonth {
  /** "April", "May Y2". */
  name: string;
  days: number;
  ledger: Ledger;
  /** Cash in and out that isn't income or running costs: building, loans and grants. */
  flows: CashFlows;
  openingCash: number;
  closingCash: number;
}

export const roster = signal<RosterData | null>(null);

export interface ReportData {
  today: { ledger: Ledger; stats: FlowStats };
  history: DayReport[];
  /** Today's share of the block contract, paid at midnight. */
  blockDue: number;
  funding: Funding;
  reputation: number;
  /** How private demand scales with reputation. */
  reputationFactor: number;
  /** Private income's share of all income lately, and the Hybrid cap. */
  privateShare: number;
  privateCap: number;
  /** This month so far, and last month's statement (if there is one). */
  month: StatementMonth;
  lastMonth: StatementMonth | null;
  /** Patients in the department now, by stage label. */
  now: { label: string; count: number }[];
  waitingSeats: { total: number; taken: number };
  /** Ambulances parked in a bay, and waiting outside for a space. */
  ambulances: { parked: number; waiting: number; spaces: number };
  /** 4-hour performance over the last 7 full days, or null before the first. */
  fourHourWeek: number | null;
  /** Mortuary spaces in use, and deceased patients waiting for the Medical Examiner. */
  mortuary: { total: number; taken: number; awaitingReview: number };
  /** Ward beds in use, of the total, and admitted patients waiting in A&E for one. */
  wardBeds: { total: number; inUse: number; waiting: number };
  /** Outpatient waiting lists by specialty (only those with a list or a clinic running). */
  waitingLists: {
    name: string;
    open: boolean;
    firstWaiting: number;
    booked: number;
    followUps: number;
    surgery: number;
    /** Of everyone on the list, private patients. */
    private: number;
    pathways: number;
    within18w: number;
    longestWeeks: number;
  }[];
  /** Most recent patient safety incidents, newest first. */
  incidents: {
    id: number;
    when: string;
    summary: string;
    patient: string;
    where: string;
    at: { x: number; y: number };
    causes: string[];
  }[];
}
export const report = signal<ReportData | null>(null);
export const toasts = signal<Toast[]>([]);

let nextToast = 1;

export function showToast(text: string, kind: Toast["kind"] = "info"): void {
  const t = { id: nextToast++, text, kind };
  toasts.value = [...toasts.value.slice(-3), t];
  setTimeout(() => (toasts.value = toasts.value.filter((x) => x !== t)), 3500);
}

/** Hover help for whatever is under the mouse on the map. */
export const mapHelp = signal<{ x: number; y: number; content: HelpContent } | null>(null);
/** Hover help for the build palette entry under the mouse. */
export const paletteHelp = signal<{ x: number; y: number; content: HelpContent } | null>(null);

/** Plan mode: build actions go into the plan instead of being built. */
export const planning = signal(false);
/** Size and net cost of the current plan (kept when leaving plan mode). */
export const planSummary = signal<{ steps: number; cost: number }>({ steps: 0, cost: 0 });

/** Map overlay showing which beds nurse stations can see (GAME_DESIGN §7). */
export const coverageOverlay = signal(false);

/** The Patients dialog: every patient's status. */
export const patientsOpen = signal(false);

/** The Staff screen and its tab: who's working, hiring, and the rota. */
export type StaffTab = "team" | "hire" | "rota";
export const staffScreen = signal<StaffTab | null>(null);
/** The Hospital dialog and its tab, and what it shows. */
export type HospitalTab =
  "departments" | "escalation" | "policies" | "events" | "inspections" | "performance";
export const hospitalTab = signal<HospitalTab | null>(null);
export const hospitalData = signal<HospitalData | null>(null);

/** The Finance dialog and its tab, and what it shows. */
export type FinanceTab = "statement" | "departments" | "loans" | "grants";
export const financeTab = signal<FinanceTab | null>(null);
export const financeData = signal<FinanceData | null>(null);

/** A member of staff to pick out in the Team tab (from a notification). */
export const staffHighlight = signal<number | null>(null);

export interface PatientRow {
  id: number;
  name: string;
  condition: string;
  /** Triage category, once triaged. */
  category?: { n: number; label: string; colour: string; target: string; note: string };
  status: string;
  /** What's holding them up, if anything. */
  reason: string | null;
  group: "arriving" | "waiting" | "treatment" | "ward" | "leaving";
  /** Room they're in. */
  where: string;
  inDeptMins: number;
  inDept: string;
  /** Over 4 hours in A&E. */
  breached: boolean;
  /** Progress against the next target, e.g. "Doctor due in 25 min". */
  target: string;
  overdue: boolean;
  /** Minutes until the next target (negative = overdue; Infinity = none). */
  dueIn: number;
  mood: number;
  needs: string[];
  /** Interventions needed now, most critical first (e.g. "Observations overdue by 20m"). */
  alerts: string[];
  /** Inpatients: the specialty they're under; null in A&E. */
  admittedTo: string | null;
}

export interface PatientTable {
  rows: PatientRow[];
  counts: {
    /** In A&E (not on a ward). */
    total: number;
    arriving: number;
    waiting: number;
    treatment: number;
    breached: number;
    /** Inpatients on wards. */
    ward: number;
  };
  longestWait: string | null;
}

export interface StaffRow {
  id: number;
  name: string;
  roleId: StaffRoleId;
  role: string;
  status: "free" | "on_the_way" | "waiting" | "working" | "at_desk" | "no_desk" | "off_site";
  activity: string;
  progress: number | null;
  patient: { id: number; name: string } | null;
  where: string;
  /** At work now (on site and not on their way home). */
  atWork: boolean;
  morale: number;
  skill: number;
  /** Null with rotas off (nobody tires). */
  fatigue: number | null;
  /** Bank or agency, off sick, working notice. */
  flags: { label: string; tone: "info" | "warn" | "bad" }[];
  /** Off sick, working notice, low morale or very tired. */
  attention: boolean;
}

export interface StaffTable {
  rows: StaffRow[];
  busy: number;
  free: number;
  atWork: number;
  sick: number;
  notice: number;
  bank: number;
  agency: number;
  lowMorale: number;
}

export const patientTable = signal<PatientTable | null>(null);
export const staffTable = signal<StaffTable | null>(null);
