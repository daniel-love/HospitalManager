/**
 * Plan mode: build commands queued as a blueprint instead of being built.
 *
 * The plan is a list of commands stored in SimState (so it's saved). A
 * preview — a copy of the real state with the plan applied and money ignored
 * — shows what the hospital would look like and what it would cost. Building
 * the plan replays it on the real state, all or nothing.
 *
 * Plan steps can refer to items created by earlier steps ("place a chair",
 * then "move that chair"). Item ids depend on what exists when the plan is
 * applied, so each replay maps the ids a step created last time to the ids
 * it creates this time.
 */
import { applyCommand, type Command } from "./commands";
import type { SimState } from "./state";
import type { FloorGrid } from "./world/grid";

export interface PlanEntry {
  cmd: Command;
  /** Id of the item this step created when last applied (place_object only). */
  createdId?: number;
}

export interface PlanPreview {
  /** The real state with the plan applied. Never ticked; money is ignored. */
  state: SimState;
  /** Net cost of the plan (refunds from removals are subtracted). */
  cost: number;
}

interface Replay {
  cost: number;
  kept: PlanEntry[];
  dropped: number;
}

/** Applies plan entries to `state`, remapping ids and skipping steps that fail. */
function replay(state: SimState, entries: PlanEntry[]): Replay {
  const created = new Set(entries.flatMap((e) => (e.createdId === undefined ? [] : [e.createdId])));
  const remap = new Map<number, number>();
  const kept: PlanEntry[] = [];
  let cost = 0;
  let dropped = 0;
  for (const entry of entries) {
    const cmd = remapIds(entry.cmd, created, remap);
    const nextId = state.nextObjectId;
    const result = cmd ? applyCommand(state, cmd) : null;
    if (!cmd || !result?.ok) {
      dropped++;
      continue;
    }
    cost += result.cost;
    if (cmd.type === "place_object") {
      if (entry.createdId !== undefined) remap.set(entry.createdId, nextId);
      kept.push({ cmd, createdId: nextId });
    } else {
      kept.push({ cmd });
    }
  }
  return { cost, kept, dropped };
}

/**
 * Rewrites a step's item id to the id that item has now. Null if it refers to
 * an item an earlier (now dropped) step was meant to create.
 */
function remapIds(cmd: Command, created: Set<number>, remap: Map<number, number>): Command | null {
  if (cmd.type !== "move_object" && cmd.type !== "remove_object") return cmd;
  if (!created.has(cmd.id)) return cmd; // An item that already existed for real.
  const id = remap.get(cmd.id);
  return id === undefined ? null : { ...cmd, id };
}

function cloneState(state: SimState): SimState {
  return structuredClone(state);
}

/**
 * Builds the preview from the real state and its plan. Steps that no longer
 * fit (e.g. something was built for real in their way) are removed from the
 * plan; returns how many.
 */
export function buildPreview(real: SimState): { preview: PlanPreview; dropped: number } {
  const state = cloneState(real);
  state.plan = [];
  state.money = Number.MAX_SAFE_INTEGER;
  const { cost, kept, dropped } = replay(state, real.plan);
  real.plan = kept;
  state.plan = kept;
  return { preview: { state, cost }, dropped };
}

/** Adds a step to the plan by applying it to the preview. */
export function addToPlan(real: SimState, preview: PlanPreview, cmd: Command) {
  const nextId = preview.state.nextObjectId;
  const result = applyCommand(preview.state, cmd);
  if (result.ok) {
    real.plan.push(cmd.type === "place_object" ? { cmd, createdId: nextId } : { cmd });
    preview.cost += result.cost;
  }
  return result;
}

export type CommitResult = { ok: true; cost: number; steps: number } | { ok: false; error: string };

/**
 * Builds the whole plan for real, or nothing: it's checked on a copy first,
 * with real money, so a plan that can't be paid for doesn't half-build.
 */
export function commitPlan(real: SimState): CommitResult {
  if (real.plan.length === 0) return { ok: false, error: "The plan is empty" };
  const trial = cloneState(real);
  const check = replay(trial, real.plan);
  if (check.dropped > 0) {
    return { ok: false, error: "The plan no longer fits, or you can't afford it all" };
  }
  const steps = real.plan.length;
  const { cost } = replay(real, real.plan);
  real.plan = [];
  return { ok: true, cost, steps };
}

/** Tiles where the planned layout differs from the real one. */
export function planDiff(real: SimState, preview: SimState, floor = 0) {
  const a = real.floors[floor]!;
  const b = preview.floors[floor]!;
  const added: number[] = [];
  const removed: number[] = [];
  for (let i = 0; i < a.floorType.length; i++) {
    const gained = has(b, i, a);
    const lost = has(a, i, b);
    if (gained) added.push(i);
    else if (lost) removed.push(i);
  }
  return { added, removed };
}

/** Whether tile i of `g` has something `other` doesn't. */
function has(g: FloorGrid, i: number, other: FloorGrid): boolean {
  return (
    (g.floorType[i] !== 0 && other.floorType[i] === 0) ||
    (g.wall[i] !== 0 && other.wall[i] !== g.wall[i]) ||
    (g.door[i] !== 0 && other.door[i] !== g.door[i]) ||
    (g.zone[i] !== 0 && other.zone[i] !== g.zone[i]) ||
    (g.objectId[i] !== -1 && other.objectId[i] !== g.objectId[i]) ||
    (g.mountId[i] !== -1 && other.mountId[i] !== g.mountId[i])
  );
}
