/**
 * Bridge from the game to the Preact UI. The game writes these signals (the
 * HUD a few times a second); components re-render when the values change.
 * UI-owned choices (selected tool, open panel) live here too, and the game
 * reads them.
 */
import { signal } from "@preact/signals";
import type { Speed } from "@game/loop";
import type { Tool } from "@game/tools";
import type { StaffRoleId } from "@data/schema";
import type { DayReport, FlowStats, Ledger } from "@sim/agents";
import type { Rotation, RoomCheck } from "@sim/state";
import type { HelpContent } from "./help";

export interface HudState {
  clock: string;
  speed: Speed;
  money: number;
  /** Patients in the department right now. */
  patients: number;
  /** Today's 4-hour performance (share leaving A&E within 4 hours), or null before anyone has. */
  fourHour: number | null;
}

export interface DebugStats {
  fps: number;
  frameMs: number;
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

/** A patient or member of staff, for the inspector. */
export type AgentInfo =
  | {
      kind: "patient";
      id: number;
      name: string;
      condition: string;
      /** Triage category name and colour, once triaged. */
      category?: { label: string; colour: string; target: string };
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
      afterDeath?: { label: string; done: boolean; detail?: string }[];
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
      kind: "staff";
      id: number;
      name: string;
      role: string;
      activity: string;
      annualCost: number;
      /** 0–100. */
      morale: number;
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
});
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

/** Management panel open on the left (closes the build palette). */
export type SidePanel = "staff" | "reports";
export const sidePanel = signal<SidePanel | null>(null);

export interface Notification {
  id: number;
  /** In-game time, e.g. "Day 2  14:05". */
  when: string;
  text: string;
  severity: "info" | "warn" | "bad";
  at?: { x: number; y: number };
}
export const notifications = signal<Notification[]>([]);

export interface RosterData {
  /** Roles to hire, by staff group, in display order. */
  groups: { name: string; roles: RosterRole[] }[];
  staff: { id: number; name: string; role: string; activity: string }[];
  /** Total staff cost per year. */
  payroll: number;
}

export interface RosterRole {
  id: StaffRoleId;
  name: string;
  description: string;
  annualCost: number;
  count: number;
}

export const roster = signal<RosterData | null>(null);

export interface ReportData {
  today: { ledger: Ledger; stats: FlowStats };
  history: DayReport[];
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

/** The People dialog (patients and staff tables), or null when closed. */
export type PeopleTab = "patients" | "staff";
export const peopleDialog = signal<PeopleTab | null>(null);

export interface PatientRow {
  id: number;
  name: string;
  condition: string;
  /** Triage category, once triaged. */
  category?: { n: number; label: string; colour: string; target: string };
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
  status: "free" | "on_the_way" | "waiting" | "working" | "at_desk" | "no_desk";
  activity: string;
  progress: number | null;
  patient: { id: number; name: string } | null;
  where: string;
}

export interface StaffTable {
  rows: StaffRow[];
  busy: number;
  free: number;
}

export const patientTable = signal<PatientTable | null>(null);
export const staffTable = signal<StaffTable | null>(null);
