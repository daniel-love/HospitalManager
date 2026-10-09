/**
 * Shows what's waiting to be cleaned: brown smudges on a couch, trolley, bed
 * or toilet that needs a clean (a couch, trolley or bed can't be used until
 * it's had one), a blue sparkle while a cleaner is at work on it, and a red
 * badge on a toilet too dirty to use. Redrawn only when that changes.
 */
import { Graphics } from "pixi.js";
import { cleaningStatuses, type CleaningStatus } from "@sim/places";
import type { SimState } from "@sim/state";
import { objectRect } from "@sim/world/objects";
import { TILE_SIZE } from "./constants";

const SMUDGE = 0x6b4a2b;
const SPARKLE = 0x7fd3ff;
const OUT_OF_USE = 0xe0504a;

export class CleaningLayer {
  readonly container = new Graphics();
  private last = "";

  update(state: SimState): void {
    const statuses = cleaningStatuses(state);
    const key = [...statuses].map(([id, s]) => `${id}:${s}`).join(",");
    if (key === this.last) return;
    this.last = key;
    const g = this.container.clear();
    for (const [id, status] of statuses) {
      const obj = state.objects[id];
      if (obj) draw(g, objectRect(obj), status);
    }
  }

  clear(): void {
    this.last = "";
    this.container.clear();
  }
}

function draw(g: Graphics, r: { x: number; y: number; w: number; h: number }, s: CleaningStatus) {
  const T = TILE_SIZE;
  const cx = (r.x + r.w / 2) * T;
  const cy = (r.y + r.h / 2) * T;
  const across = Math.min(r.w, r.h) * T;
  const along = Math.max(r.w, r.h) * T;
  const lengthways = r.h >= r.w;
  // Smudges spread along the item: fainter once a cleaner has started.
  const alpha = s === "cleaning" ? 0.3 : 0.65;
  for (const [a, b, rad] of [
    [-0.3, -0.15, 0.32],
    [0.05, 0.2, 0.26],
    [0.32, -0.1, 0.22],
  ] as const) {
    const da = a * along;
    const db = b * across;
    g.circle(cx + (lengthways ? db : da), cy + (lengthways ? da : db), rad * across).fill({
      color: SMUDGE,
      alpha,
    });
  }
  // A badge at the top right, visible when zoomed out.
  const bx = (r.x + r.w) * T - 4;
  const by = r.y * T + 4;
  if (s === "cleaning") {
    // A four-pointed sparkle.
    const a = 8;
    const b = 2.5;
    g.poly([
      bx,
      by - a,
      bx + b,
      by - b,
      bx + a,
      by,
      bx + b,
      by + b,
      bx,
      by + a,
      bx - b,
      by + b,
      bx - a,
      by,
      bx - b,
      by - b,
    ])
      .fill(SPARKLE)
      .stroke({ width: 1, color: 0x1d232b });
  } else {
    g.circle(bx, by, 7)
      .fill(s === "out_of_use" ? OUT_OF_USE : SMUDGE)
      .stroke({
        width: 1.5,
        color: 0xffffff,
      });
    if (s === "out_of_use") g.rect(bx - 4, by - 1, 8, 2).fill(0xffffff);
    else g.circle(bx, by, 2).fill(0xffffff);
  }
}
