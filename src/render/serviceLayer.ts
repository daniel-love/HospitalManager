/**
 * Equipment out of service (systems/maintenance.ts): a red cross over an
 * item that has broken down, an amber one while a clinical engineer works
 * on it, and a grey bolt badge on powered kit without power in a power cut.
 * Redrawn only when that changes.
 */
import { Graphics } from "pixi.js";
import type { SimState } from "@sim/state";
import { objectRect } from "@sim/world/objects";
import { isPowered } from "@sim/world/service";
import { TILE_SIZE } from "./constants";

const BROKEN = 0xe0504a;
const REPAIRING = 0xf2c94c;
const NO_POWER = 0x4a5568;

type Status = "broken" | "repairing" | "no_power";

function statuses(state: SimState): Map<number, Status> {
  const out = new Map<number, Status>();
  for (const [key, m] of Object.entries(state.maintenance)) {
    const id = Number(key);
    if (m.broken === null || !state.objects[id]) continue;
    const working = Object.values(state.jobs).some(
      (j) => j.objectId === id && j.kind === "repair" && j.state === "working",
    );
    out.set(id, working ? "repairing" : "broken");
  }
  for (const o of Object.values(state.objects)) {
    if (!out.has(o.id) && !isPowered(state, o.id)) out.set(o.id, "no_power");
  }
  return out;
}

export class ServiceLayer {
  readonly container = new Graphics();
  private last = "";

  update(state: SimState, floor = 0): void {
    const now = statuses(state);
    const key = [...now].map(([id, s]) => `${id}:${s}`).join(",");
    if (`${floor}|${key}` === this.last) return;
    this.last = `${floor}|${key}`;
    const g = this.container.clear();
    for (const [id, status] of now) {
      const obj = state.objects[id];
      if (obj && obj.floor === floor) draw(g, objectRect(obj), status);
    }
  }

  clear(): void {
    this.last = "";
    this.container.clear();
  }
}

function draw(g: Graphics, r: { x: number; y: number; w: number; h: number }, s: Status): void {
  const T = TILE_SIZE;
  // A badge at the bottom left, clear of the cleaning badge at the top right.
  const bx = r.x * T + 6;
  const by = (r.y + r.h) * T - 6;
  if (s === "no_power") {
    g.circle(bx, by, 6).fill({ color: NO_POWER, alpha: 0.9 });
    // A lightning bolt.
    g.poly([
      bx + 1,
      by - 4,
      bx - 2.5,
      by + 0.5,
      bx,
      by + 0.5,
      bx - 1,
      by + 4,
      bx + 2.5,
      by - 0.5,
      bx,
      by - 0.5,
    ]).fill(0xffffff);
    return;
  }
  const colour = s === "broken" ? BROKEN : REPAIRING;
  // Outline the item, and a cross badge.
  g.rect(r.x * T + 1, r.y * T + 1, r.w * T - 2, r.h * T - 2).stroke({
    color: colour,
    width: 2,
    alpha: 0.9,
  });
  g.circle(bx, by, 6).fill({ color: colour, alpha: 0.95 });
  g.moveTo(bx - 3, by - 3)
    .lineTo(bx + 3, by + 3)
    .moveTo(bx + 3, by - 3)
    .lineTo(bx - 3, by + 3)
    .stroke({ color: 0xffffff, width: 1.5 });
}
