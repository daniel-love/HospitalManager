/**
 * Stairs and lifts: the ways between floors (ROADMAP M7 step 2). A staircase
 * or lift placed in the same spot (and facing the same way) on floors next to
 * each other joins them; a run of them up through the building is one
 * portal. People get on and off at the front of the item on each floor.
 *
 * Stairs never break; a lift is out of service if any of its floors' units
 * is (broken down, or without power in a power cut).
 */
import { equipmentById } from "@data/catalogue";
import type { Point } from "../agents";
import { frontOf } from "../places";
import type { PlacedObject, SimState } from "../state";
import { inService } from "./service";

export type PortalKind = "stairs" | "lift";

export interface Portal {
  kind: PortalKind;
  /** Stable id: "kind:x:y:rotation", the same on every floor. */
  key: string;
  /** Floors it serves, lowest first, contiguous. */
  floors: number[];
  /** The item on each floor it serves, by floor. */
  objects: Map<number, PlacedObject>;
}

export function portalKind(defId: string): PortalKind | null {
  const caps = equipmentById.get(defId)?.capabilities ?? [];
  if (caps.includes("lift")) return "lift";
  if (caps.includes("stairs")) return "stairs";
  return null;
}

const cache = new WeakMap<SimState, { version: number; portals: Portal[] }>();

/** Every portal joining two or more floors, cached per layout. */
export function portals(state: SimState): Portal[] {
  const cached = cache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached.portals;
  const stacks = new Map<string, { kind: PortalKind; byFloor: Map<number, PlacedObject> }>();
  for (const o of Object.values(state.objects)) {
    const kind = portalKind(o.defId);
    if (!kind) continue;
    const key = `${kind}:${o.x}:${o.y}:${o.rotation}`;
    const s = stacks.get(key) ?? { kind, byFloor: new Map() };
    s.byFloor.set(o.floor, o);
    stacks.set(key, s);
  }
  const out: Portal[] = [];
  for (const [key, s] of [...stacks].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Runs of consecutive floors: a gap splits the stack.
    const floors = [...s.byFloor.keys()].sort((a, b) => a - b);
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const objects = new Map(run.map((f) => [f, s.byFloor.get(f)!]));
        out.push({ kind: s.kind, key: `${key}:${run[0]}`, floors: run, objects });
      }
      run = [];
    };
    for (const f of floors) {
      if (run.length > 0 && f !== run[run.length - 1]! + 1) flush();
      run.push(f);
    }
    flush();
  }
  cache.set(state, { version: state.layoutVersion, portals: out });
  return out;
}

export function portalByKey(state: SimState, key: string): Portal | undefined {
  return portals(state).find((p) => p.key === key);
}

/** Where people get on and off on a floor: in front of the item. */
export function portalStop(portal: Portal, floor: number): Point {
  return frontOf(portal.objects.get(floor)!);
}

/** Whether a portal can be used now: a lift needs every unit in service. */
export function portalWorking(state: SimState, portal: Portal): boolean {
  if (portal.kind === "stairs") return true;
  for (const o of portal.objects.values()) if (!inService(state, o.id)) return false;
  return true;
}

/** Whether a portal runs between two floors. */
export function serves(portal: Portal, a: number, b: number): boolean {
  return portal.floors.includes(a) && portal.floors.includes(b);
}
