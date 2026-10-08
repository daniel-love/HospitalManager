/**
 * Bridge from the game to the Preact UI. The game writes these signals (the
 * HUD a few times a second); components re-render when the values change.
 * UI-owned choices (selected tool, open panel) live here too, and the game
 * reads them.
 */
import { signal } from "@preact/signals";
import type { Speed } from "@game/loop";
import type { Tool } from "@game/tools";
import type { Rotation, RoomCheck } from "@sim/state";
import type { HelpContent } from "./help";

export interface HudState {
  clock: string;
  speed: Speed;
  money: number;
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
}

export interface InspectorData {
  tile: { x: number; y: number };
  room?: {
    name: string;
    department: string;
    description: string;
    size: string;
    valid: boolean;
    checks: RoomCheck[];
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
  };
}

export type BuildTab = "construction" | "rooms" | "equipment";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export const hud = signal<HudState>({ clock: "", speed: 1, money: 0 });
export const debugStats = signal<DebugStats | null>(null);
export const debugVisible = signal<boolean>(import.meta.env.DEV);

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
