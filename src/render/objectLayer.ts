/**
 * Draws placed equipment as coloured blocks with a short label. Doors are
 * drawn by the tilemap. sync() diffs against SimState, so only added or
 * removed objects touch the scene graph.
 */
import { Container, Graphics, Text } from "pixi.js";
import { equipmentById } from "@data/catalogue";
import type { Access, EquipmentDef } from "@data/schema";
import type { PlacedObject, Rotation, SimState } from "@sim/state";
import { frontDirection, objectRect } from "@sim/world/objects";
import { kitsOut } from "@sim/world/sharedKit";
import type { Rect } from "@sim/world/rect";
import { TILE_SIZE } from "./constants";
import { CATEGORY_COLOURS, STAFF_COLOUR } from "./palette";

const INSET = 3;
const KIT_AWAY_ALPHA = 0.25;

export class ObjectLayer {
  readonly container = new Container();
  /** Floor items below, wall/ceiling fixtures on top so they stay visible. */
  private readonly floorItems = new Container();
  private readonly fixtures = new Container();

  constructor() {
    this.container.addChild(this.floorItems, this.fixtures);
  }

  /** Each view remembers where it was drawn, so moved objects get redrawn. */
  private readonly views = new Map<number, { view: Container; at: string }>();

  sync(state: SimState): void {
    for (const [id, { view, at }] of this.views) {
      const obj = state.objects[id];
      if (!obj || placement(obj) !== at) {
        view.destroy({ children: true });
        this.views.delete(id);
      }
    }
    for (const obj of Object.values(state.objects)) {
      if (this.views.has(obj.id)) continue;
      const def = equipmentById.get(obj.defId);
      if (!def) continue; // Doors.
      const view = drawEquipment(def, objectRect(obj), obj.rotation);
      this.views.set(obj.id, { view, at: placement(obj) });
      (def.mount === "floor" ? this.floorItems : this.fixtures).addChild(view);
    }
  }

  /**
   * Labels are unreadable when zoomed far out, so hide them. Shared kit
   * that's out with someone (drawn beside them by the agent layer) leaves a
   * faint outline where it's kept.
   */
  update(zoom: number, state: SimState): void {
    const showText = zoom >= 0.55;
    const out = kitsOut(state);
    for (const [id, { view }] of this.views) {
      const label = view.children.find((c) => c instanceof Text);
      if (label) label.visible = showText;
      view.alpha = out.has(id) ? KIT_AWAY_ALPHA : 1;
    }
  }

  clear(): void {
    for (const { view } of this.views.values()) view.destroy({ children: true });
    this.views.clear();
  }
}

function placement(obj: PlacedObject): string {
  return `${obj.x},${obj.y},${obj.rotation}`;
}

/** One item: a block, a bar on its front edge, and its glyph. */
export function drawEquipment(def: EquipmentDef, r: Rect, rotation: Rotation): Container {
  const view = new Container();
  const g = new Graphics();
  if (def.id === "mortuary_fridge") {
    // Drawn as what it is; its drawers carry the deceased's tags, so no glyph.
    drawFridge(g, r, rotation);
    view.addChild(g);
    return view;
  }
  const colour = CATEGORY_COLOURS[def.category];
  let centre = { x: (r.x + r.w / 2) * TILE_SIZE, y: (r.y + r.h / 2) * TILE_SIZE };
  let fontSize = 11;
  if (def.mount === "floor") {
    drawBlock(g, r, rotation, colour, 1, def.access);
  } else {
    const plate = drawFixture(g, r, rotation, def.mount, colour, 1);
    centre = { x: plate.x + plate.w / 2, y: plate.y + plate.h / 2 };
    fontSize = 8;
  }
  const label = new Text({
    text: def.glyph,
    style: { fontFamily: "system-ui, sans-serif", fontSize, fontWeight: "700", fill: 0x1d232b },
    resolution: 4,
  });
  label.anchor.set(0.5);
  label.position.set(centre.x, centre.y);
  view.addChild(g, label);
  return view;
}

/**
 * A mounted fixture. Wall: a slim plate against the wall behind it (its back
 * edge). Ceiling: a dashed track line across the tile. Returns the plate's
 * rectangle in world pixels, for placing the label.
 */
export function drawFixture(
  g: Graphics,
  r: Rect,
  rotation: Rotation,
  mount: "wall" | "ceiling",
  colour: number,
  alpha: number,
): { x: number; y: number; w: number; h: number } {
  const T = TILE_SIZE;
  const x = r.x * T;
  const y = r.y * T;
  const w = r.w * T;
  const h = r.h * T;
  const { dx, dy } = frontDirection(rotation);
  if (mount === "wall") {
    const depth = 12;
    const pad = 3;
    // The plate hugs the edge opposite the front (the wall side).
    const plate =
      dy > 0
        ? { x: x + pad, y: y + 1, w: w - pad * 2, h: depth }
        : dy < 0
          ? { x: x + pad, y: y + h - 1 - depth, w: w - pad * 2, h: depth }
          : dx > 0
            ? { x: x + 1, y: y + pad, w: depth, h: h - pad * 2 }
            : { x: x + w - 1 - depth, y: y + pad, w: depth, h: h - pad * 2 };
    g.roundRect(plate.x, plate.y, plate.w, plate.h, 3).fill({ color: colour, alpha });
    g.roundRect(plate.x, plate.y, plate.w, plate.h, 3).stroke({
      width: 1.5,
      color: MARK,
      alpha: 0.7 * alpha,
    });
    return plate;
  }
  // Ceiling track, running across the front direction.
  const horizontal = dy !== 0;
  const segs = 4;
  for (let i = 0; i < segs; i++) {
    const t0 = (i + 0.15) / segs;
    const t1 = (i + 0.85) / segs;
    if (horizontal) g.rect(x + w * t0, y + h / 2 - 2, w * (t1 - t0), 4);
    else g.rect(x + w / 2 - 2, y + h * t0, 4, h * (t1 - t0));
  }
  g.fill({ color: colour, alpha });
  const tag = horizontal
    ? { x: x + w / 2 - 9, y: y + h / 2 - 15, w: 18, h: 10 }
    : { x: x + w / 2 + 3, y: y + h / 2 - 5, w: 18, h: 10 };
  g.roundRect(tag.x, tag.y, tag.w, tag.h, 2).fill({ color: colour, alpha: 0.9 * alpha });
  return tag;
}

const MARK = 0x1d232b;

const FRIDGE_STEEL = 0xa9b4be;
const FRIDGE_CONDENSER = 0x6f7a86;
const FRIDGE_DOOR = 0xdde6ee;
const FRIDGE_SEAM = 0x5f6b77;
const FRIDGE_LED = 0x4fd18b;

/**
 * A mortuary fridge: a steel cabinet with the condenser along its back and a
 * door per body along its front, each with a handle on the staff side. Doors
 * are split along the front edge, matching where deathMarks puts the tags.
 */
function drawFridge(g: Graphics, r: Rect, rotation: Rotation): void {
  const T = TILE_SIZE;
  const x = r.x * T + INSET;
  const y = r.y * T + INSET;
  const w = r.w * T - INSET * 2;
  const h = r.h * T - INSET * 2;
  const { dx, dy } = frontDirection(rotation);
  const along = dy !== 0;
  const length = along ? w : h;
  const depth = along ? h : w;
  /** A rect at `u` along the front and `v` in from the back, in world pixels. */
  const at = (u: number, v: number, lu: number, lv: number): [number, number, number, number] =>
    dy > 0
      ? [x + u, y + v, lu, lv]
      : dy < 0
        ? [x + u, y + depth - v - lv, lu, lv]
        : dx > 0
          ? [x + v, y + u, lv, lu]
          : [x + depth - v - lv, y + u, lv, lu];

  g.roundRect(x, y, w, h, 4).fill(FRIDGE_STEEL);

  // Condenser housing with vent slats, and a green "temperature OK" light.
  const back = 6;
  g.roundRect(...at(0, 0, length, back), 3).fill(FRIDGE_CONDENSER);
  for (let u = 6; u < length - 10; u += 4) g.rect(...at(u, 1.5, 1.5, back - 3));
  g.fill({ color: MARK, alpha: 0.35 });
  const [lx, ly, lw, lh] = at(length - 5, back / 2 - 1.5, 3, 3);
  g.circle(lx + lw / 2, ly + lh / 2, 1.6).fill(FRIDGE_LED);

  // Staff work from the front.
  const band = 3;
  g.rect(...at(0, depth - band, length, band)).fill(STAFF_COLOUR);

  // One door per drawer, each with a handle by the front.
  const doors = 3;
  const gap = 1.5;
  const doorLen = length / doors;
  const doorTop = back + 1.5;
  const doorDepth = depth - band - 1 - doorTop;
  for (let i = 0; i < doors; i++) {
    const u = i * doorLen + gap;
    g.roundRect(...at(u, doorTop, doorLen - gap * 2, doorDepth), 2)
      .fill(FRIDGE_DOOR)
      .stroke({ width: 1, color: FRIDGE_SEAM });
    const handle = Math.min(9, doorLen - 8);
    g.roundRect(
      ...at(i * doorLen + (doorLen - handle) / 2, depth - band - 5.5, handle, 2.5),
      1,
    ).fill({ color: MARK, alpha: 0.8 });
  }

  g.roundRect(x, y, w, h, 4).stroke({ width: 1.5, color: MARK, alpha: 0.7 });
}

/**
 * An item block with its orientation and access marked (rotation 0 faces
 * down):
 * - an arrow on the front edge when users (patients, visitors) use the front
 * - a blue band on each side staff work from (e.g. behind a reception desk)
 * - a dark band along an unused back (headboard, chair back, wall side)
 * Items with no access sides (plants, bins) get no markings.
 */
export function drawBlock(
  g: Graphics,
  r: Rect,
  rotation: Rotation,
  colour: number,
  alpha: number,
  access: readonly Access[],
): void {
  const T = TILE_SIZE;
  const x = r.x * T + INSET;
  const y = r.y * T + INSET;
  const w = r.w * T - INSET * 2;
  const h = r.h * T - INSET * 2;
  g.roundRect(x, y, w, h, 4).fill({ color: colour, alpha });

  if (access.length > 0) {
    const { dx, dy } = frontDirection(rotation);
    const who = (side: Access["side"]) => access.find((a) => a.side === side)?.who;
    const band = 5;
    /** A band along the inside of the edge facing (ex, ey). */
    const edgeBand = (ex: number, ey: number): [number, number, number, number] =>
      ey > 0
        ? [x, y + h - band, w, band]
        : ey < 0
          ? [x, y, w, band]
          : ex > 0
            ? [x + w - band, y, band, h]
            : [x, y, band, h];

    const back = who("back");
    if (back === "staff") {
      g.roundRect(...edgeBand(-dx, -dy), 3).fill({ color: STAFF_COLOUR, alpha });
    } else if (back === undefined) {
      g.roundRect(...edgeBand(-dx, -dy), 3).fill({ color: MARK, alpha: 0.6 * alpha });
    }
    if (who("sides") === "staff") {
      g.roundRect(...edgeBand(-dy, dx), 3).fill({ color: STAFF_COLOUR, alpha });
      g.roundRect(...edgeBand(dy, -dx), 3).fill({ color: STAFF_COLOUR, alpha });
    }
    const front = who("front");
    if (front === "staff") {
      g.roundRect(...edgeBand(dx, dy), 3).fill({ color: STAFF_COLOUR, alpha });
    }
    if (front !== undefined) {
      // Arrow: tip just past the front edge's midpoint, base inside the block.
      const mx = x + w / 2 + (dx * w) / 2;
      const my = y + h / 2 + (dy * h) / 2;
      const half = 5;
      const [px, py] = [-dy, dx];
      const bx = mx - dx * 5;
      const by = my - dy * 5;
      g.poly([
        mx + dx * 3,
        my + dy * 3,
        bx + px * half,
        by + py * half,
        bx - px * half,
        by - py * half,
      ]).fill({ color: MARK, alpha: 0.85 * alpha });
    }
  }
  g.roundRect(x, y, w, h, 4).stroke({ width: 1.5, color: MARK, alpha: 0.55 * alpha });
}
