/**
 * Parking-space markings on Ambulance Bays: a yellow box round each space the
 * sim has packed into the bay (so the lines always match where ambulances
 * park, however wide the bay is drawn), and yellow hatching over the leftover
 * hardstanding that's too small for another ambulance. The bay's outer edge is
 * drawn with the floor (tilemapLayer.ts). Redrawn only when the layout changes.
 */
import { Graphics } from "pixi.js";
import { baySpaces } from "@sim/systems/ambulances";
import type { SimState } from "@sim/state";
import { TILE_SIZE } from "./constants";
import { BAY_MARKING } from "./palette";

const LINE = 3;

export class BayLayer {
  readonly container = new Graphics();

  sync(state: SimState): void {
    const spaces = baySpaces(state);
    const bays = state.rooms.filter(
      (r) => r.valid && r.typeId === "ambulance_bay" && r.floor === 0,
    );
    const g = this.container.clear();
    const T = TILE_SIZE;
    const grid = state.floors[0]!;

    const used = new Set<number>();
    for (const { x, y, w, h } of spaces) {
      for (let ty = y; ty < y + h; ty++) {
        for (let tx = x; tx < x + w; tx++) used.add(ty * grid.width + tx);
      }
      // Inset so neighbouring spaces show a clear divider, not one thick line.
      const i = 5;
      g.rect(x * T + i, y * T + i, w * T - i * 2, h * T - i * 2).stroke({
        width: LINE,
        color: BAY_MARKING,
        alignment: 1,
      });
      // A bar across the rear, where the doors open onto the stretcher. A
      // parked ambulance faces +y lengthways, or -x crossways (agentLayer.ts).
      const bar = T * 0.35;
      const tint = { color: BAY_MARKING, alpha: 0.35 };
      if (h >= w) g.rect(x * T + i, y * T + i, w * T - i * 2, bar).fill(tint);
      else g.rect((x + w) * T - i - bar, y * T + i, bar, h * T - i * 2).fill(tint);
    }

    // Diagonal hatching on leftover tiles, lined up across neighbouring tiles.
    for (const room of bays) {
      for (const idx of room.tiles) {
        if (used.has(idx)) continue;
        const px = (idx % grid.width) * T;
        const py = Math.floor(idx / grid.width) * T;
        g.moveTo(px, py + T / 2).lineTo(px + T / 2, py);
        g.moveTo(px, py + T).lineTo(px + T, py);
        g.moveTo(px + T / 2, py + T).lineTo(px + T, py + T / 2);
      }
    }
    g.stroke({ width: 2, color: BAY_MARKING, alpha: 0.7 });
  }
}
