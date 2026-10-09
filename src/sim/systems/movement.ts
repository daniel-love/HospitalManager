/**
 * Moving agents along routes. Other systems decide where an agent should be
 * and call headTo() every tick; it plans a route the first time (or after the
 * layout changes) and reports whether the agent has arrived. moveAgents()
 * then walks everyone along their routes.
 */
import { PATIENT_SPEED, STAFF_SPEED } from "@data/patients";
import type { AgentBase, Point } from "../agents";
import type { SimState } from "../state";
import { FloorType, tileIndex } from "../world/grid";
import { findPath } from "../world/pathfinding";

/** Ticks to wait before retrying a route that couldn't be found. */
const RETRY_TICKS = 60;
/** Walking through a doorway is slower. */
const DOOR_SPEED_FACTOR = 0.6;
/** Walking across grass is slower than on floor or paving (see GRASS_COST). */
const GRASS_SPEED_FACTOR = 0.5;
const EPS = 1e-6;

export type Arrival = "arrived" | "moving" | "no_route";

/**
 * Sends an agent to `to`, walking via the tile `approach` (default: `to`
 * itself). Used to walk up beside a couch and then lie on it, say.
 */
export function headTo(
  state: SimState,
  agent: AgentBase,
  to: Point,
  approach: Point = to,
  /** Being wheeled on a bed: double doors and 2-wide corridors only. */
  bed = false,
): Arrival {
  const d = agent.dest;
  const same =
    d !== null && d.x === to.x && d.y === to.y && d.ax === approach.x && d.ay === approach.y;
  if (same) {
    if (d.blocked >= 0) {
      if (state.tick - d.blocked < RETRY_TICKS) return "no_route";
      return plan(state, agent, to, approach, bed);
    }
    if (agent.path.length === 0) return "arrived";
    if (agent.pathVersion !== state.layoutVersion) return plan(state, agent, to, approach, bed);
    return "moving";
  }
  return plan(state, agent, to, approach, bed);
}

/** Stops the agent where it is. */
export function stop(agent: AgentBase): void {
  agent.path = [];
  agent.dest = null;
}

/** Whether an agent is at a point (and not walking somewhere else). */
export function isAt(agent: AgentBase, p: Point): boolean {
  return agent.path.length === 0 && Math.abs(agent.x - p.x) < EPS && Math.abs(agent.y - p.y) < EPS;
}

function plan(
  state: SimState,
  agent: AgentBase,
  to: Point,
  approach: Point,
  bed: boolean,
): Arrival {
  const dest = { x: to.x, y: to.y, ax: approach.x, ay: approach.y, blocked: -1 };
  agent.dest = dest;
  agent.pathVersion = state.layoutVersion;
  if (Math.abs(agent.x - to.x) < EPS && Math.abs(agent.y - to.y) < EPS) {
    agent.path = [];
    return "arrived";
  }
  const grid = state.floors[0]!;
  const sx = Math.round(agent.x);
  const sy = Math.round(agent.y);
  const tiles = findPath(grid, sx, sy, approach.x, approach.y, bed);
  if (!tiles) {
    dest.blocked = state.tick;
    agent.path = [];
    return "no_route";
  }
  const path: number[] = [];
  for (const i of tiles) path.push(i % grid.width, Math.floor(i / grid.width));
  if (to.x !== approach.x || to.y !== approach.y) path.push(to.x, to.y);
  // Already standing on the approach tile but slightly off-centre: walk to it.
  if (path.length === 0) path.push(approach.x, approach.y);
  agent.path = path;
  return "moving";
}

export function moveAgents(state: SimState): void {
  const grid = state.floors[0]!;
  const step = (agent: AgentBase, speed: number) => {
    agent.prevX = agent.x;
    agent.prevY = agent.y;
    if (agent.path.length === 0) return;
    const tx = Math.round(agent.x);
    const ty = Math.round(agent.y);
    let budget = speed;
    if (tx >= 0 && ty >= 0 && tx < grid.width && ty < grid.height) {
      const i = tileIndex(grid, tx, ty);
      if (grid.door[i] !== 0) budget *= DOOR_SPEED_FACTOR;
      else if (grid.floorType[i] === FloorType.Grass) budget *= GRASS_SPEED_FACTOR;
    }
    while (budget > EPS && agent.path.length > 0) {
      const wx = agent.path[0]!;
      const wy = agent.path[1]!;
      const dx = wx - agent.x;
      const dy = wy - agent.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        agent.x = wx;
        agent.y = wy;
        agent.path.splice(0, 2);
        budget -= dist;
      } else {
        agent.x += (dx / dist) * budget;
        agent.y += (dy / dist) * budget;
        budget = 0;
      }
    }
  };
  for (const p of Object.values(state.patients)) step(p, PATIENT_SPEED);
  for (const s of Object.values(state.staff)) step(s, STAFF_SPEED);
}
